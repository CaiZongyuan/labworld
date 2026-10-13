"""Resource ownership for bounded source-tool processes and interruption cleanup."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from format import SourceToolError


def process_start_ticks(pid):
    path = Path('/proc') / str(pid) / 'stat'
    if sys.platform != 'linux' or not path.exists():
        return None
    return path.read_text().rsplit(')', 1)[1].split()[19]


class OwnedRun:
    def __init__(self, directory, operation):
        self.directory = Path(directory).resolve()
        self.run_id = str(uuid.uuid4())
        self.operation = operation
        self.child = None
        self.previous_handlers = {}
        self.ledger = {'owner': 'tools/newton-source', 'run_id': self.run_id, 'operation': operation,
                       'directory': str(self.directory), 'processes': [], 'ports': [], 'docker_resources': [],
                       'started_at': time.time(), 'status': 'prepared', 'retained_purpose': 'Source export, native evidence and owned caches'}

    def save(self):
        (self.directory / 'owned-resources.json').write_text(json.dumps(self.ledger, indent=2) + '\n')

    def __enter__(self):
        try:
            self.directory.mkdir(parents=True, exist_ok=False)
        except FileExistsError as error:
            raise SourceToolError('output_exists', str(self.directory), 'Use a new output directory; existing data is preserved.') from error
        for signum in (signal.SIGINT, signal.SIGTERM):
            self.previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, self.interrupt)
        self.save()
        return self

    def interrupt(self, signum, _frame):
        self.ledger['interrupted_signal'] = signum
        self.stop()
        raise KeyboardInterrupt

    def stop(self):
        if self.child is None:
            return
        receipt = self.directory / 'blender-process.json'
        if receipt.exists() and sys.platform == 'linux':
            value = json.loads(receipt.read_text())
            if value.get('run_id') == self.run_id and self.ledger.get('windows_blender'):
                pid = int(value['pid'])
                # Match the recorded PID and this run's job path before terminating a native Windows process.
                powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
                job = self.ledger['blender_job'].replace("'", "''")
                script = f"$p=Get-CimInstance Win32_Process | Where-Object {{ $_.ProcessId -eq {pid} }}; if ($p -and $p.CommandLine.Contains('{job}')) {{ Stop-Process -Id {pid} }}"
                subprocess.run([powershell, '-NoProfile', '-Command', script], capture_output=True, timeout=10)
        if self.child.poll() is not None:
            if self.ledger['processes']:
                self.ledger['processes'][-1]['stopped'] = True
            return
        try:
            if os.name == 'posix':
                os.killpg(self.child.pid, signal.SIGTERM)
            else:
                self.child.terminate()
            self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name == 'posix':
                os.killpg(self.child.pid, signal.SIGKILL)
            else:
                self.child.kill()
            self.child.wait(timeout=5)
        except ProcessLookupError:
            pass
        if self.ledger['processes']:
            self.ledger['processes'][-1]['stopped'] = self.child.poll() is not None

    def run(self, command, name, timeout=180, env=None):
        self.ledger['windows_blender'] = name == 'blender' and command[0].lower().endswith('.exe')
        if name == 'blender':
            self.ledger['blender_job'] = command[-1]
        with (self.directory / (name + '.stdout.log')).open('w') as out, (self.directory / (name + '.stderr.log')).open('w') as err:
            self.child = subprocess.Popen(command, cwd=self.directory, env=env, stdout=out, stderr=err,
                                          start_new_session=os.name == 'posix')
            self.ledger['processes'].append({'pid': self.child.pid, 'name': name, 'stopped': False,
                                             'start_ticks': process_start_ticks(self.child.pid)})
            self.save()
            try:
                code = self.child.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                self.stop()
                raise SourceToolError('process_timeout', name) from error
            finally:
                self.ledger['processes'][-1]['stopped'] = self.child.poll() is not None
                self.save()
            if code:
                raise SourceToolError('process_failed', name, 'Read the owned process log for the exact source failure.')

    def complete(self, **facts):
        self.ledger.update(status='complete', **facts)

    def __exit__(self, error_type, error, traceback):
        self.stop()
        if error_type:
            self.ledger['status'] = 'failed'
            self.ledger['error'] = str(error)
        self.ledger['ended_at'] = time.time()
        self.ledger['retained_bytes'] = sum(p.stat().st_size for p in self.directory.rglob('*') if p.is_file())
        self.ledger['reconciled'] = all(p['stopped'] for p in self.ledger['processes'])
        self.save()
        for signum, handler in self.previous_handlers.items():
            signal.signal(signum, handler)


def recover(directory):
    """Reconcile a known interrupted run; never discover or remove other owners."""
    directory = Path(directory).resolve()
    ledger_file = directory / 'owned-resources.json'
    ledger = json.loads(ledger_file.read_text())
    if ledger.get('owner') != 'tools/newton-source' or ledger.get('directory') != str(directory):
        raise SourceToolError('resource_owner_mismatch', str(directory))
    uuid.UUID(ledger['run_id'])
    receipt_file = directory / 'blender-process.json'
    if ledger.get('windows_blender') and sys.platform == 'linux' and receipt_file.exists():
        receipt = json.loads(receipt_file.read_text())
        if receipt.get('run_id') == ledger['run_id']:
            pid = int(receipt['pid'])
            marker = ledger['blender_job'].replace("'", "''")
            script = f"$p=Get-CimInstance Win32_Process | Where-Object {{ $_.ProcessId -eq {pid} }}; if ($p -and $p.CommandLine.Contains('{marker}')) {{ Stop-Process -Id {pid} }}"
            subprocess.run(['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoProfile', '-Command', script],
                           capture_output=True, timeout=10, check=True)
    for process in ledger['processes']:
        pid = int(process['pid'])
        if sys.platform == 'linux':
            command = Path('/proc') / str(pid) / 'cmdline'
            if command.exists():
                actual = command.read_bytes().replace(b'\0', b' ').decode(errors='replace')
                marker = ledger.get('blender_job')
                if (str(directory) not in actual and not (marker and marker in actual)) or (
                        process.get('start_ticks') and process_start_ticks(pid) != process['start_ticks']):
                    raise SourceToolError('resource_consumer_mismatch', str(pid))
                os.killpg(pid, signal.SIGTERM)
                deadline = time.monotonic()+5
                while command.exists() and time.monotonic()<deadline:
                    time.sleep(0.05)
                if command.exists():
                    os.killpg(pid, signal.SIGKILL)
            process['stopped'] = not command.exists()
        elif not process['stopped']:
            raise SourceToolError('resource_recovery_platform_unsupported', str(pid))
    ledger['reconciled'] = all(p['stopped'] for p in ledger['processes'])
    ledger['recovered_at'] = time.time()
    ledger_file.write_text(json.dumps(ledger, indent=2)+'\n')
    return {'reconciled': ledger['reconciled'], 'retained_directory': str(directory)}
