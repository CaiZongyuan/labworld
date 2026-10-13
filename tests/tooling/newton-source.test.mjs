import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

test('source CLI identifies malformed nested pose and joint state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'labworld-source-state-'));
  try {
    const manifest = join(directory, 'scene.json');
    for (const [state, code, path] of [
      [
        { poses: [null], joints: [] },
        'initial_pose_invalid',
        'initial_state.poses/0',
      ],
      [
        { poses: null, joints: [] },
        'initial_pose_invalid',
        'initial_state.poses',
      ],
      [
        { poses: [], joints: [null] },
        'initial_joint_invalid',
        'initial_state.joints/0',
      ],
      [
        { poses: [], joints: null },
        'initial_joint_invalid',
        'initial_state.joints',
      ],
    ]) {
      await writeFile(
        manifest,
        JSON.stringify({
          schema_version: 1,
          source_id: '7e99f905-7839-4bf2-80f6-001102031989',
          coordinate_frame: 'rh-y-up-m',
          source_coordinate_frame: 'rh-z-up-m',
          objects: [],
          components: [],
          resources: [],
          bodies: [],
          joints: [],
          source_hierarchy: [],
          initial_state: state,
        }),
      );
      const result = spawnSync(
        python,
        ['-B', cli, 'validate', '--manifest', manifest],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(JSON.parse(result.stderr), {
        code,
        path,
        message: code,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'source cleanup records failed Windows termination as incomplete and retains retry evidence',
  {
    skip: process.platform !== 'linux',
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labworld-source-cleanup-'));
    try {
      const runId = '7e99f905-7839-4bf2-80f6-001102031989';
      const job = join(directory, 'blender-job.json');
      const original = {
        owner: 'tools/newton-source',
        run_id: runId,
        directory,
        processes: [],
        windows_blender: true,
        blender_job: job,
        reconciled: true,
        retained_purpose: 'Native termination failure and recovery evidence',
      };
      await writeFile(
        join(directory, 'owned-resources.json'),
        JSON.stringify(original),
      );
      await writeFile(
        join(directory, 'blender-process.json'),
        JSON.stringify({ run_id: runId, pid: 912345 }),
      );
      await writeFile(
        join(directory, 'powershell.exe'),
        "#!/usr/bin/env node\nprocess.stderr.write('Forced matching Stop-Process failure');\nprocess.exit(1);\n",
        { mode: 0o755 },
      );
      const cleanup = () =>
        spawnSync(python, ['-B', cli, 'cleanup', '--output', directory], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: directory + delimiter + process.env.PATH,
          },
        });
      const result = cleanup();
      assert.equal(result.status, 2, result.stderr);
      assert.equal(
        JSON.parse(result.stderr).code,
        'resource_cleanup_incomplete',
      );
      const failed = JSON.parse(
        await readFile(join(directory, 'owned-resources.json'), 'utf8'),
      );
      assert.equal(failed.reconciled, false);
      assert.equal(failed.windows_process.stopped, false);
      assert.equal(failed.owner, original.owner);
      assert.equal(failed.retained_purpose, original.retained_purpose);
      assert.match(failed.cleanup_error.message, /Stop-Process failure/);
      assert.equal(
        JSON.parse(
          await readFile(join(directory, 'blender-process.json'), 'utf8'),
        ).pid,
        912345,
      );

      // A successful shell exit cannot substitute for observing the recorded process stop.
      await writeFile(
        join(directory, 'powershell.exe'),
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({ pid: 912345, stopped: false }));\n',
        { mode: 0o755 },
      );
      const active = cleanup();
      assert.equal(active.status, 2, active.stderr);
      assert.equal(
        JSON.parse(
          await readFile(join(directory, 'owned-resources.json'), 'utf8'),
        ).reconciled,
        false,
      );

      await writeFile(
        join(directory, 'powershell.exe'),
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({ pid: 912345, stopped: true }));\n',
        { mode: 0o755 },
      );
      const recovered = cleanup();
      assert.equal(recovered.status, 0, recovered.stderr);
      const clean = JSON.parse(
        await readFile(join(directory, 'owned-resources.json'), 'utf8'),
      );
      assert.equal(clean.reconciled, true);
      assert.equal(clean.windows_process.stopped, true);
      assert.equal(clean.cleanup_error, undefined);
      assert.equal(clean.status, 'recovered');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'source-owned lifecycle cannot mark Windows Blender reconciled from an exited WSL child',
  {
    skip: process.platform !== 'linux',
  },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'labworld-source-lifecycle-'),
    );
    try {
      await writeFile(
        join(directory, 'powershell.exe'),
        "#!/usr/bin/env node\nprocess.stderr.write('Forced matching Stop-Process failure');\nprocess.exit(1);\n",
        { mode: 0o755 },
      );
      const output = join(directory, 'owned');
      const program = `
import json,sys
from pathlib import Path
from ownership import OwnedRun
from format import SourceToolError
try:
    with OwnedRun(Path(sys.argv[1]), 'termination-proof') as owner:
        owner.run([sys.executable, '-c', 'pass'], 'native')
        owner.ledger['windows_blender'] = True
        owner.ledger['blender_job'] = str(owner.directory / 'blender-job.json')
        (owner.directory / 'blender-process.json').write_text(json.dumps({'run_id': owner.run_id, 'pid': 912345}))
        owner.complete()
except SourceToolError as error:
    print(json.dumps(error.report()), file=sys.stderr)
    raise SystemExit(2)
`;
      const result = spawnSync(python, ['-B', '-c', program, output], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: fileURLToPath(
            new URL('../../tools/newton-source', import.meta.url),
          ),
          PATH: directory + delimiter + process.env.PATH,
        },
      });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(
        JSON.parse(result.stderr).code,
        'resource_cleanup_incomplete',
      );
      const failed = JSON.parse(
        await readFile(join(output, 'owned-resources.json'), 'utf8'),
      );
      assert.equal(failed.processes[0].stopped, true);
      assert.equal(failed.windows_process.stopped, false);
      assert.equal(failed.reconciled, false);
      assert.equal(failed.status, 'cleanup-incomplete');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
