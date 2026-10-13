import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const python = process.env.LAB_WORLD_SOURCE_PYTHON;
const project = process.env.LAB_WORLD_SOURCE_PROJECT;
const checkpoint = process.env.LAB_WORLD_SOURCE_CHECKPOINT;
const cache = process.env.LAB_WORLD_SOURCE_CACHE;
const cli = fileURLToPath(
  new URL('../../tools/newton-source/cli.py', import.meta.url),
);

test(
  'normal source capture samples actual policy steps with an independent native witness',
  { skip: !python || !project || !checkpoint },
  async () => {
    const evidence = process.env.LAB_WORLD_SOURCE_EVIDENCE;
    if (evidence) await mkdir(evidence, { recursive: true });
    const directory = await mkdtemp(
      join(evidence ?? tmpdir(), 'labworld-native-source-'),
    );
    try {
      const output = join(directory, 'capture');
      const args = [
        '-B',
        cli,
        'capture',
        '--project',
        project,
        '--checkpoint',
        checkpoint,
        '--output',
        output,
        '--steps',
        '3',
      ];
      if (cache) args.push('--cache-directory', cache);
      const result = spawnSync(python, args, {
        encoding: 'utf8',
        timeout: 260_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const samples = (await readFile(join(output, 'samples.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(samples[0].hook, 'post-reset');
      assert.equal(samples.filter((s) => s.hook === 'post-step').length, 3);
      assert.equal(samples.at(-1).state.source_sim_time_ns, '100000000');
      const model = JSON.parse(
        await readFile(join(output, 'native-model.json'), 'utf8'),
      );
      assert.equal(model.joints.filter((j) => j.motion_supported).length, 6);
      assert.equal(
        samples
          .at(-1)
          .raw_joints.reduce((sum, j) => sum + j.coordinates.length, 0),
        20,
      );
      const witness = (
        await readFile(join(output, 'native-witness.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(witness.at(-1).source_sim_time_ns, '100000000');
      assert.equal(Object.keys(witness.at(-1).body_transforms).length, 9);
      const paths = new Map(
        model.bodies.map((b) => [b.pose_key, b.source_path]),
      );
      for (let i = 0; i < samples.length; i++) {
        assert.equal(
          samples[i].state.source_sim_time_ns,
          witness[i].source_sim_time_ns,
        );
        for (const pose of samples[i].state.poses) {
          const raw = witness[i].body_transforms[paths.get(pose.pose_key)];
          assert.ok(raw, paths.get(pose.pose_key));
          const expected = [raw[0], raw[2], -raw[1]];
          assert.ok(
            pose.position.every(
              (v, axis) => Math.abs(v - expected[axis]) < 1e-5,
            ),
          );
          const q = [raw[3], raw[5], -raw[4], raw[6]];
          assert.ok(
            Math.abs(
              Math.abs(
                pose.quaternion.reduce((sum, v, axis) => sum + v * q[axis], 0),
              ) - 1,
            ) < 1e-5,
          );
        }
      }
      const ledger = JSON.parse(
        await readFile(join(output, 'owned-resources.json'), 'utf8'),
      );
      assert.equal(ledger.source_files_unchanged, true);
      assert.equal(ledger.reconciled, true);
    } finally {
      if (!evidence) await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'normal source capture preserves reset boundaries without recycling old outcome or source time',
  { skip: !python || !project || !checkpoint },
  async () => {
    const evidence = process.env.LAB_WORLD_SOURCE_EVIDENCE;
    if (evidence) await mkdir(evidence, { recursive: true });
    const directory = await mkdtemp(
      join(evidence ?? tmpdir(), 'labworld-native-reset-'),
    );
    try {
      const output = join(directory, 'capture');
      const args = [
        '-B',
        cli,
        'capture',
        '--project',
        project,
        '--checkpoint',
        checkpoint,
        '--output',
        output,
        '--steps',
        '3',
        '--reset-after',
        '2',
      ];
      if (cache) args.push('--cache-directory', cache);
      const result = spawnSync(python, args, {
        encoding: 'utf8',
        timeout: 260_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const samples = (await readFile(join(output, 'samples.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      const boundary = samples.findIndex((s) => s.hook === 'pre-reset');
      assert.ok(boundary > 0);
      assert.equal(samples[boundary].state.episode_id, '0');
      assert.equal(samples[boundary + 1].hook, 'post-reset');
      assert.equal(samples[boundary + 1].state.episode_id, '1');
      assert.equal(
        samples[boundary].state.source_sim_time_ns,
        samples[boundary + 1].state.source_sim_time_ns,
      );
      assert.equal(samples[boundary + 1].termination, null);
      assert.equal(samples.at(-1).state.source_sim_time_ns, '100000000');
      const event = JSON.parse(
        (await readFile(join(output, 'events.jsonl'), 'utf8')).trim(),
      );
      assert.equal(event.result, 'unknown');
      assert.equal(event.episode_id, '0');
      const ledger = JSON.parse(
        await readFile(join(output, 'owned-resources.json'), 'utf8'),
      );
      assert.equal(ledger.reconciled, true);
      assert.equal(ledger.source_files_unchanged, true);
    } finally {
      if (!evidence) await rm(directory, { recursive: true, force: true });
    }
  },
);
