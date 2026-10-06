import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { loadLegacyConfigFields } from '../../scripts/lib/legacy-config.mjs';
test('frozen config preserves literal defaults/order and rejects changed source without compiling Rust', () => {
  const fields = loadLegacyConfigFields(resolve('.'));
  assert.equal(fields[0].name, 'DATABASE_URL');
  assert.equal(fields[1].name, 'APP_BIND');
  assert.equal(fields[1].default, '127.0.0.1:3000');
  assert.equal(fields[0].secret, true);
  const root = mkdtempSync(join(tmpdir(), 'lab-word-frozen-config-'));
  const snapshotPath = 'docs/reference/frozen-legacy-config.json';
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  try {
    for (const path of [snapshotPath, ...Object.keys(snapshot.sourceHashes)]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(path, join(root, path));
    }
    assert.deepEqual(loadLegacyConfigFields(root), fields);
    const source = join(root, 'crates/platform/src/config.rs');
    writeFileSync(
      source,
      readFileSync(source, 'utf8').replace('127.0.0.1:3000', '127.0.0.1:3999'),
    );
    assert.throws(() => loadLegacyConfigFields(root), /source changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
