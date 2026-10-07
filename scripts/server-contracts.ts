import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { schemaVersion } from '../packages/server/src/platform/db/index.ts';
const version = (
  JSON.parse(readFileSync('apps/server/package.json', 'utf8')) as {
    version: string;
  }
).version;
const directory = resolve('.scratch/vnext-m1/contract-targets');
mkdirSync(directory, { recursive: true });
const descriptor = resolve(directory, randomUUID() + '.json');
writeFileSync(
  descriptor,
  JSON.stringify({
    command: process.execPath,
    args: ['--experimental-strip-types', 'apps/server/src/main.ts'],
    version,
    schemaVersion,
  }) + '\n',
);
const child = spawn(
  process.execPath,
  [
    'scripts/contract-suite.mjs',
    '--target',
    'candidate',
    '--descriptor',
    descriptor,
  ],
  { stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => child.kill(signal));
child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
