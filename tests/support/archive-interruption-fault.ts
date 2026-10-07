/** Filesystem-boundary barrier after real copy, or just before directory publication. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const copy = fs.copyFile,
  rename = fs.rename,
  destination = resolve(process.env.ARCHIVE_FAULT_DESTINATION!);
let held = false;
async function barrier(boundary: string) {
  if (held || boundary !== process.env.ARCHIVE_FAULT_BOUNDARY) return;
  held = true;
  // Keep this test barrier alive even before production acquires its stage lease.
  const handle = setInterval(() => {}, 1000);
  await fs.writeFile(
    process.env.ARCHIVE_FAULT_REPORT!,
    JSON.stringify({ boundary }) + '\n',
  );
  await new Promise<void>((resume) => process.once('SIGTERM', resume));
  clearInterval(handle);
}
fs.copyFile = async (source, target, mode) => {
  await copy(source, target, mode);
  await barrier('copy');
};
fs.rename = async (source, target) => {
  const publishing =
    typeof target === 'string' && resolve(target) === destination;
  if (publishing) await barrier('publication');
  await rename(source, target);
  if (publishing) await barrier('published');
};
syncBuiltinESMExports();
try {
  await import('../../apps/server/src/cli.ts');
} finally {
  fs.copyFile = copy;
  fs.rename = rename;
  syncBuiltinESMExports();
}
