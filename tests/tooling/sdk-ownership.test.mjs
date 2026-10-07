import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
function project(t) {
  const fixture = mkdtempSync(join(tmpdir(), 'labword-sdk-ownership-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const files = [
    'scripts/check-boundaries.mjs',
    'scripts/lib/server-boundaries.mjs',
    'packages/server/src',
    'packages/server/migrations',
    'scripts/lib/process.mjs',
  ];
  for (const pkg of ['contracts', 'sdk', 'core', 'ui', 'views'])
    files.push(`packages/${pkg}/package.json`, `packages/${pkg}/src`);
  for (const file of files) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    cpSync(join(repository, file), join(fixture, file), { recursive: true });
  }
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  symlinkSync(
    join(repository, 'node_modules'),
    join(fixture, 'node_modules'),
    'dir',
  );
  return fixture;
}
function check(fixture) {
  return execFileSync(process.execPath, ['scripts/check-boundaries.mjs'], {
    cwd: fixture,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('the public boundary checker allows owned SDK helpers and rejects business contracts in unowned SDK or Core files', (t) => {
  const fixture = project(t);
  assert.match(check(fixture), /ownership declarations verified/);
  for (const pkg of ['sdk', 'core']) {
    const probe = join(fixture, `packages/${pkg}/src/unowned-probe.ts`);
    writeFileSync(
      probe,
      "import type { LabWorld } from '@labos-threejs/contracts';\nexport type UnownedWorld = LabWorld;\n",
    );
    assert.throws(
      () => check(fixture),
      (error) =>
        error.status !== 0 &&
        /Core imports a Lab contract/.test(error.stderr.toString()),
    );
    rmSync(probe);
  }
  assert.match(check(fixture), /ownership declarations verified/);
});

test('the public boundary checker refuses an unowned qualified table in Node migrations', (t) => {
  const fixture = project(t);
  writeFileSync(
    join(fixture, 'packages/server/migrations/9999_unowned.sql'),
    'CREATE TABLE lab.unowned_probe(id integer);',
  );
  assert.throws(
    () => check(fixture),
    (error) =>
      error.status !== 0 &&
      /unowned table lab.unowned_probe/.test(error.stderr),
  );
});
