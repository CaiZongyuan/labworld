import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export function loadLegacyConfigFields(repository) {
  const snapshot = JSON.parse(
    readFileSync(
      join(repository, 'docs/reference/frozen-legacy-config.json'),
      'utf8',
    ),
  );
  for (const [path, expected] of Object.entries(snapshot.sourceHashes)) {
    const actual = createHash('sha256')
      .update(readFileSync(join(repository, path)))
      .digest('hex');
    if (actual !== expected)
      throw new Error(`Frozen legacy configuration source changed: ${path}`);
  }
  if (
    createHash('sha256')
      .update(JSON.stringify(snapshot.fields))
      .digest('hex') !== snapshot.fieldsChecksum
  )
    throw new Error('Frozen legacy configuration field checksum changed');
  return snapshot.fields;
}
