import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
