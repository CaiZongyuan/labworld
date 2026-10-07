import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

test('a Git checkout with autocrlf keeps generated contracts and migration SQL bytes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'lab-word-contract-checkout-'));
  const files = [
    'packages/contracts/openapi.json',
    'tests/fixtures/node-history/pre-baseline/meta/_journal.json',
    ...[
      'packages/contracts/src/generated',
      'packages/sdk/src/generated',
      'packages/server/migrations',
      'tests/fixtures/node-history/pre-baseline',
    ].flatMap((directory) =>
      readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            (directory.endsWith('/generated') || entry.name.endsWith('.sql')),
        )
        .map((entry) => join(entry.parentPath, entry.name)),
    ),
  ];
  const expected = new Map(files.map((path) => [path, readFileSync(path)]));
  function git(args) {
    const child = spawnSync('git', args, {
      cwd: temporary,
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
  }
  try {
    git(['init', '--quiet']);
    git(['config', 'core.autocrlf', 'true']);
    writeFileSync(
      join(temporary, '.gitattributes'),
      existsSync('.gitattributes') ? readFileSync('.gitattributes') : '',
    );
    for (const [path, bytes] of expected) {
      const destination = join(temporary, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    git(['add', '.']);
    for (const path of files) rmSync(join(temporary, path));
    git(['checkout-index', '--all', '--force']);
    for (const [path, bytes] of expected)
      assert.equal(
        readFileSync(join(temporary, path)).equals(bytes),
        true,
        path,
      );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
