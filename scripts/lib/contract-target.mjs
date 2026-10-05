import { spawn } from 'node:child_process';
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

const target = JSON.parse(
  readFileSync(process.env.CONTRACT_TARGET_DESCRIPTOR, 'utf8'),
);
const pidFile = process.env.CONTRACT_API_PID_FILE;
if (!pidFile) throw new Error('Use the contract supervisor');
let child;
let closing = false;
let restarts = 0;
let deadline;
function start() {
  child = spawn(target.command, target.args ?? [], {
    env: process.env,
    stdio: 'inherit',
  });
  child.once('spawn', () => {
    if (
      process.platform === 'linux' &&
      process.env.CONTRACT_PROCESS_PROOF_JOURNAL
    ) {
      const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
        .split(') ')[1]
        .split(' ');
      appendFileSync(
        process.env.CONTRACT_PROCESS_PROOF_JOURNAL,
        JSON.stringify({
          runId: process.env.CONTRACT_RUN_ID,
          pid: child.pid,
          token: stat[19],
          group: Number(stat[2]),
          session: Number(stat[3]),
        }) + '\n',
        { mode: 0o600 },
      );
    }
    writeFileSync(`${pidFile}.next`, String(child.pid), { mode: 0o600 });
    renameSync(`${pidFile}.next`, pidFile);
  });
  child.once('error', () => {
    closing = true;
    process.exitCode = 1;
  });
  child.once('exit', () => {
    clearTimeout(deadline);
    if (closing) return;
    if (++restarts > 20) {
      process.exitCode = 1;
      return;
    }
    start();
  });
}
function close() {
  if (closing) return;
  closing = true;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  child.kill('SIGTERM');
  deadline = setTimeout(() => child.kill('SIGKILL'), 4000);
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
start();
