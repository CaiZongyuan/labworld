import { spawn } from 'node:child_process';
spawn(
  process.execPath,
  [new URL('./term-child.mjs', import.meta.url).pathname, process.argv[2]],
  { stdio: 'inherit' },
);
process.on('SIGTERM', () => process.exit(0));
