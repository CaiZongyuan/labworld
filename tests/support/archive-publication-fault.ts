/** Necessary filesystem-boundary supplement; the archive is created by real HTTP/CLI. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
const destination = resolve(process.env.ARCHIVE_FAULT_DESTINATION!),
  original = fs.rename;
let refused = false;
fs.rename = async (source, target) => {
  if (
    typeof target === 'string' &&
    [destination, join(destination, 'pgdata')].includes(resolve(target))
  ) {
    refused = true;
    throw new Error('Injected archive publication failure');
  }
  return original(source, target);
};
syncBuiltinESMExports();
try {
  await import('../../apps/server/src/cli.ts');
} finally {
  fs.rename = original;
  syncBuiltinESMExports();
  await fs.writeFile(
    process.env.ARCHIVE_FAULT_REPORT!,
    JSON.stringify({ boundary: 'validated archive publication', refused }) +
      '\n',
  );
}
