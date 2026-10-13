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


def stop_windows_blender(directory, ledger):
    if not ledger.get('windows_blender'):
        return
    receipt_file = directory / 'blender-process.json'
    ledger['windows_process'] = {'stopped': False, 'receipt': str(receipt_file)}
    try:
        receipt = json.loads(receipt_file.read_text())
        if not isinstance(receipt, dict) or receipt.get('run_id') != ledger['run_id']:
            raise SourceToolError('resource_consumer_mismatch', str(receipt_file))
        pid = int(receipt['pid'])
        if pid <= 0:
            raise SourceToolError('resource_consumer_mismatch', str(receipt_file))
        if not isinstance(ledger.get('blender_job'), str) or not ledger['blender_job']:
            raise SourceToolError('resource_consumer_mismatch', str(receipt_file))
        job = ledger['blender_job'].replace("'", "''")
        ledger['windows_process'].update(pid=pid, run_id=receipt['run_id'], job=ledger['blender_job'])
        # Stop only the exact receipt/job match; independently query it after termination.
        script = f"""[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'
$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}'
if ($p) {{
  if (-not $p.CommandLine -or -not $p.CommandLine.Contains('{job}')) {{ throw 'Recorded Windows process identity does not match' }}
  Stop-Process -Id {pid} -ErrorAction Stop
}}
$deadline = (Get-Date).AddSeconds(5)
do {{
  $remaining = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}'
  $matching = $remaining -and $remaining.CommandLine -and $remaining.CommandLine.Contains('{job}')
  if ($matching) {{ Start-Sleep -Milliseconds 100 }}
}} while ($matching -and (Get-Date) -lt $deadline)
@{{ pid = {pid}; stopped = [bool](-not $matching) }} | ConvertTo-Json -Compress
"""
        result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script],
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15)
        if result.returncode:
            raise SourceToolError('resource_cleanup_incomplete', str(pid), result.stderr.strip() or 'Windows termination failed')
        status = json.loads(result.stdout)
        if not isinstance(status, dict) or status.get('pid') != pid or status.get('stopped') is not True:
            raise SourceToolError('resource_cleanup_incomplete', str(pid), 'Recorded Windows Blender is still active')
        ledger['windows_process'].update(stopped=True, checked_at=time.time())
        ledger.pop('cleanup_error', None)
    except SourceToolError:
        raise
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        raise SourceToolError('resource_cleanup_incomplete', str(receipt_file), str(error)) from error


def reconciled(ledger):
    return (all(process['stopped'] for process in ledger['processes']) and
            (not ledger.get('windows_blender') or ledger.get('windows_process', {}).get('stopped') is True))


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
        try:
            stop_windows_blender(self.directory, self.ledger)
        except SourceToolError as error:
            self.ledger['cleanup_error'] = error.report()
        if self.child is None:
            return
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
        if name == 'blender':
            self.ledger['blender_job'] = command[-1]
        with (self.directory / (name + '.stdout.log')).open('w') as out, (self.directory / (name + '.stderr.log')).open('w') as err:
            self.ledger['windows_blender'] = name == 'blender' and command[0].lower().endswith('.exe')
            try:
                self.child = subprocess.Popen(command, cwd=self.directory, env=env, stdout=out, stderr=err,
                                              start_new_session=os.name == 'posix')
            except OSError:
                # Popen failed to create the executable; no native receipt can exist.
                self.ledger['windows_blender'] = False
                raise
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
        self.ledger['reconciled'] = reconciled(self.ledger)
        if not self.ledger['reconciled']:
            self.ledger['status'] = 'cleanup-incomplete'
        self.save()
        for signum, handler in self.previous_handlers.items():
            signal.signal(signum, handler)
        if not self.ledger['reconciled']:
            raise SourceToolError('resource_cleanup_incomplete', str(self.directory),
                                  'Owned processes are not reconciled; retain the directory and retry cleanup.')


def recover(directory):
    """Reconcile a known interrupted run; never discover or remove other owners."""
    directory = Path(directory).resolve()
    ledger_file = directory / 'owned-resources.json'
    ledger = json.loads(ledger_file.read_text())
    if not isinstance(ledger, dict) or ledger.get('owner') != 'tools/newton-source' or ledger.get('directory') != str(directory):
        raise SourceToolError('resource_owner_mismatch', str(directory))
    uuid.UUID(ledger['run_id'])
    ledger['reconciled'] = False
    ledger_file.write_text(json.dumps(ledger, indent=2)+'\n')
    try:
        stop_windows_blender(directory, ledger)
    except SourceToolError as error:
        ledger['cleanup_error'] = error.report()
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
    ledger['reconciled'] = reconciled(ledger)
    if not ledger['reconciled']:
        ledger['status'] = 'cleanup-incomplete'
    elif ledger.get('status') == 'cleanup-incomplete':
        ledger['status'] = 'recovered'
    ledger['recovered_at'] = time.time()
    ledger_file.write_text(json.dumps(ledger, indent=2)+'\n')
    if not ledger['reconciled']:
        raise SourceToolError('resource_cleanup_incomplete', str(directory),
                              'Owned processes are not reconciled; retain the directory and retry cleanup.')
    return {'reconciled': ledger['reconciled'], 'retained_directory': str(directory)}
