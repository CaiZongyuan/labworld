import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(
  new URL('../../packages/views/package.json', import.meta.url),
);
const threeBuild = dirname(require.resolve('three'));
const { Box3, Matrix4, Quaternion, Vector3 } = await import(
  pathToFileURL(join(threeBuild, 'three.module.js')).href
);
const { GLTFLoader } = await import(
  pathToFileURL(join(threeBuild, '../examples/jsm/loaders/GLTFLoader.js')).href
);

const python = process.env.LAB_WORLD_SOURCE_PYTHON;
const blender = process.env.LAB_WORLD_SOURCE_BLENDER;
const cli = fileURLToPath(
  new URL('../../tools/newton-source/cli.py', import.meta.url),
);
const scene = fileURLToPath(
  new URL('../fixtures/source/static.usda', import.meta.url),
);

test(
  'normal export reconciles a missing Windows executable without masking its launch error',
  { skip: !python || process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labworld-source-launch-'));
    try {
      const missing = join(directory, 'missing-blender.exe');
      const output = join(directory, 'failed-launch');
      const result = spawnSync(
        python,
        [
          '-B',
          cli,
          'export',
          '--scene',
          scene,
          '--source-id',
          '7e99f905-7839-4bf2-80f6-001102031989',
          '--blender',
          missing,
          '--output',
          output,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 2, result.stderr);
      const error = JSON.parse(result.stderr);
      assert.equal(error.code, 'source_input_invalid');
      assert.equal(error.path, missing);
      const ledger = JSON.parse(
        await readFile(join(output, 'owned-resources.json'), 'utf8'),
      );
      assert.deepEqual(ledger.processes, []);
      assert.equal(ledger.reconciled, true);
      await assert.rejects(access(join(output, 'blender-process.json')), {
        code: 'ENOENT',
      });
      const cleanup = spawnSync(
        python,
        ['-B', cli, 'cleanup', '--output', output],
        { encoding: 'utf8' },
      );
      assert.equal(cleanup.status, 0, cleanup.stderr);
      assert.equal(JSON.parse(cleanup.stdout).reconciled, true);

      const unverified = join(directory, 'unverified-blender.exe');
      await writeFile(unverified, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const uncertainOutput = join(directory, 'started-no-receipt');
      const started = spawnSync(
        python,
        [
          '-B',
          cli,
          'export',
          '--scene',
          scene,
          '--source-id',
          '7e99f905-7839-4bf2-80f6-001102031989',
          '--blender',
          unverified,
          '--output',
          uncertainOutput,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(started.status, 2, started.stderr);
      assert.equal(
        JSON.parse(started.stderr).code,
        'resource_cleanup_incomplete',
      );
      const uncertain = JSON.parse(
        await readFile(join(uncertainOutput, 'owned-resources.json'), 'utf8'),
      );
      assert.equal(uncertain.processes.length, 1);
      assert.equal(uncertain.processes[0].stopped, true);
      assert.equal(uncertain.reconciled, false);
      const refused = spawnSync(
        python,
        ['-B', cli, 'cleanup', '--output', uncertainOutput],
        { encoding: 'utf8' },
      );
      assert.equal(refused.status, 2, refused.stderr);
      assert.equal(
        JSON.parse(refused.stderr).code,
        'resource_cleanup_incomplete',
      );
    } finally {
      // The generated executable is a known POSIX no-op, so this fixture has no native Windows consumer.
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'normal export rejects malformed snapshot state before creating conversion resources',
  { skip: !python },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'labworld-source-snapshot-'),
    );
    try {
      for (const [value, code] of [
        [[null], 'initial_state_missing'],
        [{ state: null }, 'initial_state_missing'],
        [{ state: {}, native_model: [] }, 'native_model_invalid'],
      ]) {
        const snapshot = join(directory, 'snapshot.json');
        const output = join(directory, 'unused-output');
        await writeFile(snapshot, JSON.stringify(value));
        const result = spawnSync(
          python,
          [
            '-B',
            cli,
            'export',
            '--scene',
            scene,
            '--snapshot',
            snapshot,
            '--source-id',
            '7e99f905-7839-4bf2-80f6-001102031989',
            '--blender',
            'unused-for-invalid-input',
            '--output',
            output,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 2, result.stderr);
        assert.deepEqual(JSON.parse(result.stderr), {
          code,
          path: snapshot,
          message: code,
        });
        await assert.rejects(access(output), { code: 'ENOENT' });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'normal source export retains static geometry in its local frame and guide classification',
  { skip: !python || !blender },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labworld-source-export-'));
    try {
      const output = join(directory, 'scene');
      const result = spawnSync(
        python,
        [
          '-B',
          cli,
          'export',
          '--scene',
          scene,
          '--source-id',
          '7e99f905-7839-4bf2-80f6-001102031989',
          '--blender',
          blender,
          '--output',
          output,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(
        await readFile(join(output, 'scene.json'), 'utf8'),
      );
      assert.deepEqual(
        manifest.objects.map((x) => x.object_key),
        ['Mat'],
      );
      assert.equal(manifest.components[0].origin, 'body-local');
      assert.equal(
        manifest.source_hierarchy.find((x) =>
          x.source_path.endsWith('/collision'),
        ).drawn,
        false,
      );
      const pose = manifest.initial_state.poses[0];
      assert.deepEqual(pose.position, [0.25, 0.0625, 0.125]);
      const bytes = await readFile(join(output, manifest.resources[0].path));
      assert.equal(bytes.readUInt32LE(0), 0x46546c67);
      const loaded = await new GLTFLoader().parseAsync(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
        '',
      );
      loaded.scene.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(loaded.scene);
      const size = bounds.getSize(new Vector3());
      assert.ok(Math.abs(size.x - 0.2) < 1e-6);
      assert.ok(Math.abs(size.y - 0.02) < 1e-6);
      assert.ok(Math.abs(size.z - 0.1) < 1e-6);
      const matrix = new Matrix4().compose(
        new Vector3(...pose.position),
        new Quaternion(...pose.quaternion),
        new Vector3(1, 1, 1),
      );
      const world = bounds.clone().applyMatrix4(matrix);
      assert.ok(
        world
          .getCenter(new Vector3())
          .distanceTo(new Vector3(0.25, 0.0625, 0.125)) < 1e-6,
      );
      const paths = [];
      loaded.scene.traverse((node) => {
        if (node.userData.labworld_source_path)
          paths.push(node.userData.labworld_source_path);
      });

      assert.ok(paths.includes('/World/envs/env_0/Mat/surface'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'normal export retains an exact asset description alongside original instance identity',
  { skip: !python || !blender },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'labworld-source-metadata-'),
    );
    try {
      const metadata = join(directory, 'metadata.json');
      const description = {
        asset_id: 'example/mat',
        version: '1.0.0',
        name: 'Mat',
        configuration_schema: {},
        state_schema: {},
        capabilities: [],
        resources: [],
      };
      await writeFile(join(directory, 'mat.json'), JSON.stringify(description));
      await writeFile(
        metadata,
        JSON.stringify({
          objects: [
            {
              source_path: '/World/envs/env_0/Mat',
              object_key: 'mat-instance-a',
              asset_ref: { asset_id: 'example/mat', version: '1.0.0' },
              asset_description: 'mat.json',
            },
          ],
        }),
      );
      const output = join(directory, 'scene');
      const result = spawnSync(
        python,
        [
          '-B',
          cli,
          'export',
          '--scene',
          scene,
          '--source-id',
          '7e99f905-7839-4bf2-80f6-001102031989',
          '--blender',
          blender,
          '--metadata',
          metadata,
          '--output',
          output,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(
        await readFile(join(output, 'scene.json'), 'utf8'),
      );
      assert.equal(manifest.objects[0].object_key, 'mat-instance-a');
      assert.deepEqual(manifest.objects[0].asset_ref, {
        asset_id: 'example/mat',
        version: '1.0.0',
      });
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(output, manifest.objects[0].asset_description.path),
            'utf8',
          ),
        ),
        description,
      );
      assert.equal(manifest.components[0].object_key, 'mat-instance-a');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
