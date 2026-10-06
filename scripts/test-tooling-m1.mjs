import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
// Frozen deployment/storage/mail tooling stays present until M6, but is not executed by M1.
const pending = new Set([
  'production-compose.test.mjs',
  'dev-ports.test.mjs',
  'development-mail-key.test.mjs',
  'backup-manifest.test.mjs',
  'backup-sigv4.test.mjs',
]);
const selected = readdirSync('tests/tooling')
  .filter((name) => name.endsWith('.test.mjs') && !pending.has(name))
  .map((name) => `tests/tooling/${name}`);
console.log(
  JSON.stringify({
    stage: 'M1',
    selected,
    pending: [...pending],
    docker: false,
  }),
);
const result = spawnSync(process.execPath, ['--test', ...selected], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
