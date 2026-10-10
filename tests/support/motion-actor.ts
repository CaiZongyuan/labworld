import { spawn } from 'node:child_process';

// A disposable actor must also die while SIGSTOP is in force. Normal stop
// remains the owning ledger's SIGTERM path, with its bounded escalation.
const pythonGuard = [
  'import ctypes,os,signal,sys,runpy',
  'if ctypes.CDLL(None).prctl(1,signal.SIGKILL)!=0 or os.getppid()!=int(os.environ["MOTION_E2E_PARENT_PID"]):',
  '    raise SystemExit(1)',
  'p=sys.argv.pop(1)',
  'sys.argv[0]=p',
  'sys.path.insert(0,os.path.dirname(p))',
  'runpy.run_path(p,run_name="__main__")',
].join('\n');

export function launchMotionActor(
  python: string,
  script: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  return spawn(python, ['-c', pythonGuard, script, ...args], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...environment, MOTION_E2E_PARENT_PID: String(process.pid) },
  });
}
