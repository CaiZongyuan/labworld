import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './process.mjs';

const pidFile = process.env.E2E_API_PID_FILE;
if (!pidFile) throw new Error('Use the isolated E2E runner');
let api;
let closing = false;
let restarts = 0;
let deadline;
function start() {
  api = spawn(resolve(root, 'target/debug/labos-threejs-api'), [], {
    env: process.env,
    stdio: 'inherit',
  });
  api.once('spawn', () => {
    writeFileSync(`${pidFile}.next`, String(api.pid), { mode: 0o600 });
    renameSync(`${pidFile}.next`, pidFile);
  });
  api.once('error', () => {
    closing = true;
    process.exitCode = 1;
  });
  api.once('exit', () => {
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
  if (!api?.pid || api.exitCode !== null || api.signalCode !== null) return;
  api.kill('SIGTERM');
  deadline = setTimeout(() => api.kill('SIGKILL'), 4000);
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
start();
