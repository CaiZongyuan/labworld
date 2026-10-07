/** Internal filesystem-boundary supplement; business snapshots come from real HTTP/CLI. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
const archive = resolve(process.env.ARCHIVE_FAULT_INPUT!),
  alternate = resolve(process.env.ARCHIVE_FAULT_ALTERNATE!),
  saved = join(dirname(archive), 'fault-saved-pgdata'),
  prefix = join(archive, 'pgdata') + sep,
  original = fs.copyFile;
let swapped = false;
fs.copyFile = async (source, target, mode) => {
  if (
    !swapped &&
    typeof source === 'string' &&
    resolve(source).startsWith(prefix)
  ) {
    swapped = true;
    await fs.rename(join(archive, 'pgdata'), saved);
    await fs.rename(join(alternate, 'pgdata'), join(archive, 'pgdata'));
  }
  return original(source, target, mode);
};
syncBuiltinESMExports();
try {
  await import('../../apps/server/src/cli.ts');
} finally {
  fs.copyFile = original;
  syncBuiltinESMExports();
  if (swapped) {
    await fs.rename(join(archive, 'pgdata'), join(alternate, 'pgdata'));
    await fs.rename(saved, join(archive, 'pgdata'));
  }
  await fs.writeFile(
    process.env.ARCHIVE_FAULT_REPORT!,
    JSON.stringify({
      boundary: 'first actual database file copy after archive hash validation',
      swapped,
    }) + '\n',
  );
  console.error(JSON.stringify({ event: 'internal.archive-copy', swapped }));
}
