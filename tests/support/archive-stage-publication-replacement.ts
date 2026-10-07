/** Necessary filesystem-boundary fault after actual DB validation. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
const original = fs.rename,
  destination = resolve(process.env.ARCHIVE_FAULT_DESTINATION!);
let replaced = false;
fs.rename = async (source, target) => {
  if (
    !replaced &&
    typeof source === 'string' &&
    source.endsWith('.json.next')
  ) {
    const text = await fs.readFile(source, 'utf8'),
      ledger = JSON.parse(text);
    if (ledger.destination === destination && ledger.emptyMode !== undefined) {
      replaced = true;
      await original(ledger.stage, process.env.ARCHIVE_FAULT_SAVED!);
      await fs.mkdir(ledger.stage, { mode: 0o700 });
      await fs.writeFile(
        join(ledger.stage, 'retained.txt'),
        'Preserve publication replacement',
      );
      await fs.writeFile(
        process.env.ARCHIVE_FAULT_REPORT!,
        JSON.stringify({ stage: ledger.stage, marker: target, ledger: text }) +
          '\n',
      );
    }
  }
  return original(source, target);
};
syncBuiltinESMExports();
try {
  await import('../../apps/server/src/cli.ts');
} finally {
  fs.rename = original;
  syncBuiltinESMExports();
}
