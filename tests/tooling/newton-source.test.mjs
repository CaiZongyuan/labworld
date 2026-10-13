import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(
  new URL('../../tools/newton-source/cli.py', import.meta.url),
);
const python =
  process.env.LAB_WORLD_SOURCE_PYTHON ??
  (process.platform === 'win32' ? 'python' : 'python3');

test('source CLI rejects duplicate object identity before accepting a manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labworld-source-contract-'));
  try {
    const manifest = join(directory, 'scene.json');
    await writeFile(
      manifest,
      JSON.stringify({
        schema_version: 1,
        objects: [
          { object_key: 'centrifuge-a' },
          { object_key: 'centrifuge-a' },
        ],
        components: [],
        resources: [],
        bodies: [],
        joints: [],
        source_hierarchy: [],
      }),
    );
    const result = spawnSync(
      python,
      ['-B', cli, 'validate', '--manifest', manifest],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'duplicate_object_key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source cleanup refuses an unowned directory and preserves its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labworld-other-owner-'));
  try {
    const ledger = join(directory, 'owned-resources.json');
    const original = JSON.stringify({ owner: 'other-project', directory });
    await writeFile(ledger, original);
    const result = spawnSync(
      python,
      ['-B', cli, 'cleanup', '--output', directory],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'resource_owner_mismatch');
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(ledger, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source CLI rejects changed bytes even when the resource path remains the same', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labworld-source-contract-'));
  try {
    const manifest = join(directory, 'scene.json');
    await writeFile(join(directory, 'model.glb'), 'changed');
    await writeFile(
      manifest,
      JSON.stringify({
        schema_version: 1,
        objects: [],
        resources: [
          {
            resource_key: 'web:Mat/root',
            path: 'model.glb',
            sha256: `sha256:${'0'.repeat(64)}`,
            bytes: 7,
          },
        ],
      }),
    );
    const result = spawnSync(
      python,
      ['-B', cli, 'validate', '--manifest', manifest],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'resource_digest_mismatch');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source CLI keeps an explicit incomplete asset reference as an error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labworld-source-contract-'));
  try {
    const manifest = join(directory, 'scene.json');
    await writeFile(
      manifest,
      JSON.stringify({
        schema_version: 1,
        objects: [
          {
            object_key: 'centrifuge-a',
            asset_ref: { asset_id: 'example/centrifuge' },
          },
        ],
        resources: [],
      }),
    );
    const result = spawnSync(
      python,
      ['-B', cli, 'validate', '--manifest', manifest],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'asset_reference_invalid');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source CLI rejects a resource outside the exported scene directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labworld-source-contract-'));
  try {
    const manifest = join(directory, 'scene.json');
    await writeFile(
      manifest,
      JSON.stringify({
        schema_version: 1,
        objects: [],
        resources: [
          {
            resource_key: 'web:Mat/root',
            path: '../other-project.glb',
            sha256: `sha256:${'0'.repeat(64)}`,
            bytes: 4,
          },
        ],
      }),
    );
    const result = spawnSync(
      python,
      ['-B', cli, 'validate', '--manifest', manifest],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'resource_path_invalid');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source CLI reports malformed manifest collections without a Python traceback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labworld-source-contract-'));
  try {
    const manifest = join(directory, 'scene.json');
    await writeFile(
      manifest,
      JSON.stringify({ schema_version: 1, objects: [null] }),
    );
    const result = spawnSync(
      python,
      ['-B', cli, 'validate', '--manifest', manifest],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, 'manifest_collection_invalid');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
