import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--child')) {
  writeFileSync(
    process.env.CONTRACT_LIFECYCLE_CHILD_READY,
    String(process.pid),
    { mode: 0o600 },
  );
} else {
  spawn(process.execPath, [import.meta.filename, '--child'], {
    env: process.env,
    stdio: 'ignore',
  });
}
// This owned process fixture provides a startup barrier, without a product debug route.
setInterval(() => {}, 1000);
