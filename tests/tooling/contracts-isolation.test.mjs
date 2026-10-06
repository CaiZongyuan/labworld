import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
function digest(directory) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  return createHash('sha256')
    .update(
      files
        .map((path) => readFileSync(path))
        .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)),
    )
    .digest('hex');
}
test('partial generation refuses an output alias to the official complete SDK before mutation', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'lab-word-partial-alias-'));
  const before = ['packages/contracts', 'packages/sdk'].map(digest);
  try {
    const alias = join(temporary, 'alias');
    symlinkSync(
      resolve('.'),
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const child = spawnSync(
      process.execPath,
      [
        'scripts/generate-contracts.mjs',
        '--source',
        'server',
        '--output',
        alias,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /overlaps official consumers/);
    assert.deepEqual(
      ['packages/contracts', 'packages/sdk'].map(digest),
      before,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
