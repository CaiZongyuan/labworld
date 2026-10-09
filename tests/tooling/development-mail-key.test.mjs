import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentMailKey } from '../../scripts/lib/development-mail-key.mjs';

test('development restarts reuse a private key while another project gets its own', () => {
  const first = mkdtempSync(join(tmpdir(), 'labos-threejs-mail-key-'));
  const second = mkdtempSync(join(tmpdir(), 'labos-threejs-mail-key-'));
  try {
    const key = developmentMailKey(first);
    assert.ok(/^[0-9a-f]{64}$/.test(key), 'key must contain 256 random bits');
    assert.ok(
      key === developmentMailKey(first),
      'restart must preserve pending mail decryption',
    );
    assert.ok(
      key !== developmentMailKey(second),
      'projects must not share a fixed development key',
    );
    if (process.platform !== 'win32')
      assert.equal(
        statSync(join(first, '.secrets', 'development-mail-key')).mode & 0o777,
        0o600,
      );
  } finally {
    rmSync(first, { recursive: true });
    rmSync(second, { recursive: true });
  }
});
