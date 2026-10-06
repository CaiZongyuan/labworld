import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkServerBoundaries } from '../../scripts/lib/server-boundaries.mjs';
test('server boundary validation rejects Core-to-Lab reexports and transitive domain infrastructure', () => {
  const root = mkdtempSync(join(tmpdir(), 'server-boundary-'));
  const put = (path, text) => {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, text);
  };
  try {
    put('core/system/domain.ts', 'export function valid(){return true;}');
    assert.equal(checkServerBoundaries(root), 1);
    put('lab/world/use-case.ts', 'export const world=1;');
    put(
      'core/system/bridge.ts',
      "export {world} from '../../lab/world/use-case.ts';",
    );
    assert.throws(() => checkServerBoundaries(root), /Core imports Lab/);
    put('core/system/bridge.ts', "export {sql} from 'drizzle-orm';");
    put('core/system/domain.ts', "import type {sql} from './bridge.ts';");
    assert.throws(() => checkServerBoundaries(root), /Pure Domain/);
    put('core/system/domain.ts', "import('node:fs');");
    assert.throws(() => checkServerBoundaries(root), /Pure Domain/);
    put('core/system/domain.ts', 'export const valid=true;');
    put(
      'core/system/bridge.ts',
      "import {PGlite} from '@electric-sql/pglite';",
    );
    assert.throws(() => checkServerBoundaries(root), /Only platform\/db/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
