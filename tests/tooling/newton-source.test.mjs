import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  digestTypedSceneValue,
  sceneDigestOracle,
} from '../support/source-scene-hash-oracle.mjs';

const cli = fileURLToPath(
  new URL('../../tools/newton-source/cli.py', import.meta.url),
);
const python =
  process.env.LAB_WORLD_SOURCE_PYTHON ??
  (process.platform === 'win32' ? 'python' : 'python3');

test('source CLI agrees with independent scene hash goldens across numeric and Unicode encodings', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../fixtures/source/scene-hash-v1.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(
    digestTypedSceneValue(fixture.encoder_vector.value),
    fixture.encoder_vector.sha256,
  );
  assert.equal(
    sceneDigestOracle(fixture.manifest_vector),
    fixture.manifest_vector.scene_hash,
  );
  const directory = await mkdtemp(join(tmpdir(), 'labworld-source-hash-'));
  try {
    const path = join(directory, 'scene.json');
    const validate = async (document) => {
      await writeFile(
        path,
        typeof document === 'string' ? document : JSON.stringify(document),
      );
      return spawnSync(python, ['-B', cli, 'validate', '--manifest', path], {
        encoding: 'utf8',
      });
    };
    const first = await validate(fixture.manifest_vector);
    assert.equal(first.status, 0, first.stderr);
    const lexical = JSON.stringify(fixture.manifest_vector)
      .replace('"10":0', '"10":0.0')
      .replace('"2":0', '"2":-0.0')
      .replace('"n":[true,1,1,"1"]', '"n":[true,1.0,1,"1"]');
    const equivalent = await validate(lexical);
    assert.equal(equivalent.status, 0, equivalent.stderr);
    const dynamic = structuredClone(fixture.manifest_vector);
    dynamic.source_id = 'ca29f326-80a4-4f73-8a5d-610601d9c065';
    dynamic.initial_state.source_run_id =
      '583d8dd2-4de0-46a3-814b-3bc3f49b5253';
    dynamic.initial_state.source_sim_time_ns = '100000000';
    dynamic.provenance = { reader: 'another current observation' };
    assert.equal(
      sceneDigestOracle(dynamic),
      fixture.manifest_vector.scene_hash,
    );
    const unchanged = await validate(dynamic);
    assert.equal(unchanged.status, 0, unchanged.stderr);

    const resourceManifest = structuredClone(fixture.manifest_vector);
    const resourcePath = join(directory, 'payload.bin');
    const resource = (text) => ({
      resource_key: 'resource:fixture',
      path: 'payload.bin',
      content_type: 'application/octet-stream',
      bytes: Buffer.byteLength(text),
      sha256: 'sha256:' + createHash('sha256').update(text).digest('hex'),
    });
    await writeFile(resourcePath, 'original resource bytes');
    resourceManifest.resources = [resource('original resource bytes')];
    resourceManifest.scene_hash = sceneDigestOracle(resourceManifest);
    const resourceValid = await validate(resourceManifest);
    assert.equal(resourceValid.status, 0, resourceValid.stderr);
    await writeFile(resourcePath, 'changed resource bytes');
    resourceManifest.resources = [resource('changed resource bytes')];
    assert.notEqual(
      sceneDigestOracle(resourceManifest),
      resourceManifest.scene_hash,
    );
    const resourceRejected = await validate(resourceManifest);
    assert.equal(resourceRejected.status, 2, resourceRejected.stderr);
    assert.equal(
      JSON.parse(resourceRejected.stderr).code,
      'scene_digest_mismatch',
    );

    for (const mutate of [
      (value) => {
        value.probe.n[1] = '1';
      },
      (value) => {
        value.probe.n.reverse();
      },
      (value) => {
        value.probe['\ue000'][0] += 0.01;
      },
    ]) {
      const changed = structuredClone(fixture.manifest_vector);
      mutate(changed);
      assert.notEqual(
        sceneDigestOracle(changed),
        fixture.manifest_vector.scene_hash,
      );
      const rejected = await validate(changed);
      assert.equal(rejected.status, 2);
      assert.equal(JSON.parse(rejected.stderr).code, 'scene_digest_mismatch');
    }
    for (const invalid of [9007199254740992, '\ud800']) {
      const unsafe = structuredClone(fixture.manifest_vector);
      unsafe.probe.invalid = invalid;
      assert.throws(() => sceneDigestOracle(unsafe), TypeError);
      const rejected = await validate(unsafe);
      assert.equal(rejected.status, 2, rejected.stderr);
      assert.equal(
        JSON.parse(rejected.stderr).code,
        'scene_hash_value_invalid',
      );
    }
    const keyInvalid = structuredClone(fixture.manifest_vector);
    keyInvalid.probe['\ud800'] = true;
    assert.throws(() => sceneDigestOracle(keyInvalid), TypeError);
    const keyRejected = await validate(keyInvalid);
    assert.equal(keyRejected.status, 2, keyRejected.stderr);
    assert.equal(
      JSON.parse(keyRejected.stderr).code,
      'scene_hash_value_invalid',
    );
    const integralFloat = await validate(
      JSON.stringify(fixture.manifest_vector).replace(
        '"10":0',
        '"10":9007199254740992.0',
      ),
    );
    assert.equal(integralFloat.status, 2, integralFloat.stderr);
    assert.equal(
      JSON.parse(integralFloat.stderr).code,
      'scene_hash_value_invalid',
    );
    const unsupported = {
      ...fixture.manifest_vector,
      scene_hash_algorithm: 'unknown',
    };
    const rejected = await validate(unsupported);
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.equal(
      JSON.parse(rejected.stderr).code,
      'scene_hash_algorithm_unsupported',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

test('source CLI requires the full supported joint dictionary in an actual initial state', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../fixtures/source/scene-hash-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const value = structuredClone(fixture.manifest_vector);
  value.joints = [
    {
      joint_key: 'joint:fixture',
      type: 'revolute',
      motion_supported: true,
      coordinate_key: 'joint:fixture/position',
      unit: 'rad',
      parent_body_key: null,
      child_body_key: null,
    },
  ];
  value.initial_state.source_run_id = 'ca29f326-80a4-4f73-8a5d-610601d9c065';
  value.scene_hash = sceneDigestOracle(value);
  const directory = await mkdtemp(
    join(tmpdir(), 'labworld-source-joint-dictionary-'),
  );
  try {
    const path = join(directory, 'scene.json');
    const validate = async () => {
      await writeFile(path, JSON.stringify(value));
      return spawnSync(python, ['-B', cli, 'validate', '--manifest', path], {
        encoding: 'utf8',
      });
    };
    const missing = await validate();
    assert.equal(missing.status, 2, missing.stderr);
    assert.equal(
      JSON.parse(missing.stderr).code,
      'initial_joint_dictionary_mismatch',
    );
    value.initial_state.joints = [
      { coordinate_key: 'joint:fixture/position', value: 0 },
    ];
    const complete = await validate();
    assert.equal(complete.status, 0, complete.stderr);
    for (const invalid of [false, '', 'not-a-uuid']) {
      value.initial_state.source_run_id = invalid;
      const rejected = await validate();
      assert.equal(rejected.status, 2, rejected.stderr);
      assert.equal(
        JSON.parse(rejected.stderr).code,
        'initial_source_run_invalid',
      );
    }
    value.initial_state.source_run_id = null;
    value.initial_state.joints = [];
    const authored = await validate();
    assert.equal(authored.status, 0, authored.stderr);
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
  'source-owned lifecycle distinguishes an executable launch failure from a started process without a receipt',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labworld-source-spawn-'));
    try {
      const program = `
import json,sys
from pathlib import Path
from ownership import OwnedRun
from format import SourceToolError
try:
    with OwnedRun(Path(sys.argv[1]), 'spawn-proof') as owner:
        owner.run([sys.argv[2], str(owner.directory/'blender-job.json')], 'blender')
except SourceToolError as error:
    print(json.dumps(error.report()), file=sys.stderr)
    raise SystemExit(2)
except OSError as error:
    print(json.dumps({'code':'source_input_invalid','path':error.filename,'message':str(error)}),file=sys.stderr)
    raise SystemExit(2)
`;
      const launch = (output, executable) =>
        spawnSync(python, ['-B', '-c', program, output, executable], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PYTHONPATH: fileURLToPath(
              new URL('../../tools/newton-source', import.meta.url),
            ),
          },
        });
      const missing = join(directory, 'missing-blender.exe');
      const failedOutput = join(directory, 'failed');
      const failed = launch(failedOutput, missing);
      assert.equal(failed.status, 2, failed.stderr);
      assert.equal(JSON.parse(failed.stderr).code, 'source_input_invalid');
      assert.equal(JSON.parse(failed.stderr).path, missing);
      const failedLedger = JSON.parse(
        await readFile(join(failedOutput, 'owned-resources.json'), 'utf8'),
      );
      assert.deepEqual(failedLedger.processes, []);
      assert.equal(failedLedger.reconciled, true);
      const cleanup = spawnSync(
        python,
        ['-B', cli, 'cleanup', '--output', failedOutput],
        { encoding: 'utf8' },
      );
      assert.equal(cleanup.status, 0, cleanup.stderr);

      const executable = join(directory, 'unverified-blender.exe');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const startedOutput = join(directory, 'started');
      const started = launch(startedOutput, executable);
      assert.equal(started.status, 2, started.stderr);
      assert.equal(
        JSON.parse(started.stderr).code,
        'resource_cleanup_incomplete',
      );
      const startedLedger = JSON.parse(
        await readFile(join(startedOutput, 'owned-resources.json'), 'utf8'),
      );
      assert.equal(startedLedger.processes.length, 1);
      assert.equal(startedLedger.processes[0].stopped, true);
      assert.equal(startedLedger.reconciled, false);
    } finally {
      // The fixture's POSIX no-op is known to have no native Windows process.
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
