import { expect, test } from 'vitest';
import { MotionBuffer } from './index';
import {
  motionWelcome,
  motionSnapshot,
} from '../../../tests/frontend/motion-fixture';

test('receive-clock interpolation preserves u64 time and uses normalized shortest quaternion path', () => {
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  const a = motionSnapshot();
  const b = motionSnapshot({
    sequence: a.sequence + 1n,
    sim_time_ns: a.sim_time_ns + 100_000_000n,
    poses: [{ position: [10, 2, 4], quaternion: [0, 1, 0, 0] }],
    joints: [2],
  });
  buffer.push(a, 10_000);
  buffer.push(b, 10_100);
  const sample = buffer.sample(10_150)!;
  expect(sample.poses[0].position).toEqual([5, 1, 2]);
  expect(sample.poses[0].quaternion[1]).toBeCloseTo(Math.SQRT1_2);
  expect(sample.poses[0].quaternion[3]).toBeCloseTo(Math.SQRT1_2);
  expect(sample.joints).toEqual([1]);
  expect(sample.sim_time_ns).toBe(a.sim_time_ns + 50_000_000n);
  expect(buffer.sample(10_300)?.poses[0].position).toEqual([10, 2, 4]);
  const identity = motionSnapshot({
    sequence: b.sequence + 1n,
    sim_time_ns: b.sim_time_ns + 100_000_000n,
    poses: [{ position: [10, 2, 4], quaternion: [0, -1, 0, 0] }],
  });
  buffer.push(identity, 10_200);
  expect(buffer.sample(10_250)?.poses[0].quaternion[1]).toBeCloseTo(1);
});

test('late join is complete, storage is bounded, and stale or stopped display freezes the last trusted sample', () => {
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  for (let i = 0; i < 60; i++)
    buffer.push(
      motionSnapshot({
        sequence: BigInt(i),
        sim_time_ns: 9_000_000_000_000_000n + BigInt(i) * 33_333_333n,
        poses: [{ position: [i, 0, 0], quaternion: [0, 0, 0, 1] }],
      }),
      (i * 1000) / 30,
    );
  expect(buffer.size).toBeLessThanOrEqual(8);
  const trusted = [...buffer.sample(1967)!.poses[0].position];
  expect(buffer.freshness(2600)).toBe('stale');
  expect(buffer.sample(2600)?.poses[0].position).toEqual(trusted);
  buffer.freeze();
  expect(buffer.sample(2020)?.poses[0].position).toEqual(trusted);
  buffer.push(
    motionSnapshot({
      sequence: 60n,
      poses: [{ position: [80, 0, 0], quaternion: [0, 0, 0, 1] }],
    }),
    3000,
  );
  expect(buffer.sample(3000)?.poses[0].position).toEqual([80, 0, 0]);
  buffer.clear();
  expect(buffer.size).toBe(0);
  expect(buffer.sample(4000)).toBeNull();
});

test('time rollback and long receive/simulation gaps start new segments; metadata fences reject old frames', () => {
  const buffer = new MotionBuffer();
  buffer.configure(motionWelcome);
  const a = motionSnapshot();
  expect(buffer.push(a, 0)).toBe(true);
  expect(buffer.push(a, 10)).toBe(false);
  expect(buffer.push(motionSnapshot({ epoch: a.epoch - 1n }), 10)).toBe(false);
  expect(buffer.push(motionSnapshot({ mapping_revision: 2 }), 10)).toBe(false);
  expect(buffer.push(motionSnapshot({ poses: [] }), 10)).toBe(false);
  expect(
    buffer.push(
      motionSnapshot({
        sequence: a.sequence + 1n,
        sim_time_ns: a.sim_time_ns - 1n,
        poses: [{ position: [20, 0, 0], quaternion: [0, 0, 0, 1] }],
      }),
      20,
    ),
  ).toBe(true);
  expect(buffer.sample(20)?.poses[0].position[0]).toBe(20);
  expect(
    buffer.push(
      motionSnapshot({
        sequence: a.sequence + 2n,
        sim_time_ns: a.sim_time_ns + 1n,
        poses: [{ position: [30, 0, 0], quaternion: [0, 0, 0, 1] }],
      }),
      500,
    ),
  ).toBe(true);
  expect(buffer.sample(500)?.poses[0].position[0]).toBe(30);
  expect(
    buffer.push(
      motionSnapshot({
        sequence: a.sequence + 3n,
        sim_time_ns: a.sim_time_ns + 1_000_000_000n,
        poses: [{ position: [40, 0, 0], quaternion: [0, 0, 0, 1] }],
      }),
      530,
    ),
  ).toBe(true);
  expect(buffer.sample(530)?.poses[0].position[0]).toBe(40);
  buffer.configure({
    ...motionWelcome,
    epoch: String(a.epoch + 1n),
    mapping_revision: 2,
  });
  expect(buffer.sample(540)).toBeNull();
  expect(buffer.push(motionSnapshot({ sequence: a.sequence + 4n }), 540)).toBe(
    false,
  );
});
