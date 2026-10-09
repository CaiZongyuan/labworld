import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './process.mjs';

// Keep all replacements in this supervisor's process group for runner-owned cleanup.
const pidFile = process.env.E2E_WORKER_PID_FILE;
if (!pidFile) throw new Error('Use the isolated E2E runner');
let worker;
let closing = false;
let restarts = 0;
let deadline;
function start() {
  worker = spawn(resolve(root, 'target/debug/labos-threejs-worker'), [], {
    env: process.env,
    stdio: 'inherit',
  });
  worker.once('spawn', () => {
    writeFileSync(`${pidFile}.next`, String(worker.pid), { mode: 0o600 });
    renameSync(`${pidFile}.next`, pidFile);
  });
  worker.once('error', () => {
    closing = true;
    process.exitCode = 1;
  });
  worker.once('exit', () => {
    clearTimeout(deadline);
    if (closing) return;
    if (++restarts > 3) {
      process.exitCode = 1;
      return;
    }
    start();
  });
}
function close() {
  if (closing) return;
  closing = true;
  if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null)
    return;
  worker.kill('SIGTERM');
  deadline = setTimeout(
    () => worker.kill('SIGKILL'),
    (Number(process.env.JOB_SHUTDOWN_SECS ?? 1) + 1) * 1000,
  );
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
start();
