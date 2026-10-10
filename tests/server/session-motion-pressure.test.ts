import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  encodeMotionSnapshot,
  decodeMotionSnapshot,
  parseMotionControl,
  type MotionStatus,
} from '../../packages/contracts/src/motion/index.ts';
import { MotionBuffer } from '../../packages/sdk/src/motion-buffer.ts';
import {
  MotionGateway,
  motionBudgets,
  type MotionTransport,
} from '../../packages/server/src/lab/motion/gateway.ts';
import type { MotionFixture } from '../../packages/server/src/lab/motion/fixture.ts';
import { until } from '../support/server-process.ts';

const frame = (sequence: bigint, time: bigint, x: number) =>
  encodeMotionSnapshot({
    epoch: 1n,
    sequence,
    sim_time_ns: time,
    mapping_revision: 1,
    poses: Array.from({ length: 20 }, (_, i) => ({
      position: [x + i, 0.5, 0] as const,
      quaternion: [0, 0, 0, 1] as const,
    })),
    joints: [0, 1, 2, 3, 4, 5],
  });

class BufferPeer implements MotionTransport {
  readonly buffer = new MotionBuffer();
  readonly events: string[] = [];
  readonly pausedSamples: { sequence: bigint; time: bigint; x: number }[] = [];
  open = true;
  bufferedAmount = 0;
  closeCode?: number;
  pressureReads = 0;
  stateReads = 0;
  crossSoftOnBoundary = false;
  crossedSoft = false;
  send(data: string | Uint8Array) {
    if (typeof data === 'string') {
      const control = parseMotionControl(data);
      if (control.type === 'motion.welcome') {
        this.events.push('welcome');
        this.buffer.configure(control);
      } else if (control.type === 'motion.status') {
        this.events.push(control.state);
        this.buffer.setSourceState(control.state);
        if (control.state === 'paused') {
          const sample = this.buffer.sample(performance.now());
          if (sample)
            this.pausedSamples.push({
              sequence: sample.sequence,
              time: sample.sim_time_ns,
              x: sample.poses[0].position[0],
            });
        }
      } else assert.fail(control.code);
      return;
    }
    const snapshot = decodeMotionSnapshot(data);
    this.events.push('frame:' + snapshot.sequence);
    assert.equal(this.buffer.push(snapshot, performance.now()), true);
    if (this.crossSoftOnBoundary && snapshot.sequence === 2n) {
      assert.equal(data.byteLength, 632);
      this.bufferedAmount += data.byteLength;
      this.crossedSoft = this.bufferedAmount > motionBudgets.softBytes;
      // Drain before the next Gateway tick: a dropped control must survive even
      // when no second blockedAt interval can be established.
      queueMicrotask(() => {
        this.bufferedAmount = 0;
      });
    }
  }
  close(code: number) {
    this.closeCode = code;
    this.open = false;
  }
}
function world() {
  const targets = Array.from({ length: 20 }, (_, i) => ({
    pose_key: 'body/' + i,
    entity_id: randomUUID(),
    node_id: randomUUID(),
    visual_target: 'node-root' as const,
  }));
  return {
    session_id: randomUUID(),
    lab_id: randomUUID(),
    scene_hash: 'sha256:' + '0'.repeat(64),
    mapping_revision: 1,
    pose_keys: targets.map((target) => target.pose_key),
    joint_keys: Array.from({ length: 6 }, (_, i) => 'joint/' + i),
    targets,
  } satisfies MotionFixture;
}
async function setup(rate: 15 | 30 = 30) {
  const gateway = new MotionGateway(),
    peer = new BufferPeer();
  try {
    const metadata = world();
    let state: MotionStatus['state'] = 'live';
    const source: MotionTransport = {
      bufferedAmount: 0,
      open: true,
      send() {},
      close() {},
    };
    const authority = {
      epoch: 1n,
      state: () => {
        peer.stateReads++;
        return state;
      },
    };
    const publisher = gateway.join(
      metadata,
      'publisher',
      30,
      source,
      authority,
    )!;
    const transport: MotionTransport = {
      get bufferedAmount() {
        if (peer.bufferedAmount > motionBudgets.softBytes) peer.pressureReads++;
        return peer.bufferedAmount;
      },
      get open() {
        return peer.open;
      },
      send: (data) => peer.send(data),
      close: (code) => peer.close(code),
    };
    gateway.join(metadata, 'viewer', rate, transport, authority);
    await until(async () => peer.events.includes('live'), Boolean);
    publisher.receive(frame(1n, 0n, 1));
    await until(async () => peer.events.includes('frame:1'), Boolean);
    assert.equal(
      peer.buffer.sample(performance.now())!.poses[0].position[0],
      1,
    );
    async function pauseBlocked() {
      peer.bufferedAmount = motionBudgets.softBytes + 1;
      publisher.receive(frame(2n, 100_000_000n, 2));
      state = 'paused';
      const read = peer.stateReads;
      await until(
        async () => peer.stateReads,
        (value) => value >= read + 3,
      );
      assert(peer.pressureReads > 0);
      assert.equal(peer.events.includes('paused'), false);
    }
    return {
      gateway,
      metadata,
      peer,
      publisher,
      authority,
      pauseBlocked,
      state: (next: MotionStatus['state']) => {
        state = next;
      },
    };
  } catch (error) {
    gateway.stop();
    peer.buffer.clear();
    throw error;
  }
}
function exactPause(peer: BufferPeer, recordedBoundary = true) {
  const sample = peer.buffer.sample(performance.now() + 5000)!;
  assert.equal(sample.sequence, 2n);
  assert.equal(sample.sim_time_ns, 100_000_000n);
  assert.deepEqual(sample.poses[0], {
    position: [2, 0.5, 0],
    quaternion: [0, 0, 0, 1],
  });
  assert.deepEqual(sample.joints, [0, 1, 2, 3, 4, 5]);
  if (recordedBoundary)
    assert.deepEqual(peer.pausedSamples, [
      { sequence: 2n, time: 100_000_000n, x: 2 },
    ]);
  assert.equal(peer.buffer.freshness(performance.now() + 5000), 'paused');
}
for (const rate of [15, 30] as const) {
  test(`public Gateway→Buffer drains the exact Pause boundary before paused at ${rate} Hz`, async () => {
    const f = await setup(rate),
      late = new BufferPeer();
    try {
      await f.pauseBlocked();
      f.peer.bufferedAmount = 0;
      await until(async () => f.peer.events.includes('paused'), Boolean);
      assert(
        f.peer.events.indexOf('frame:2') < f.peer.events.indexOf('paused'),
      );
      exactPause(f.peer);
      assert.equal(
        f.peer.events.filter((event) => event === 'frame:2').length,
        1,
      );
      f.gateway.join(f.metadata, 'viewer', 15, late, f.authority);
      exactPause(late, false);
      // A new trusted equal-time Resume boundary stays frozen until live status.
      f.publisher.receive(frame(3n, 100_000_000n, 2));
      await until(async () => f.peer.events.includes('frame:3'), Boolean);
      assert.equal(f.peer.buffer.sample(performance.now())!.sequence, 2n);
      f.state('live');
      await until(
        async () => f.peer.buffer.sample(performance.now())?.sequence,
        (value) => value === 3n,
      );
      assert.equal(
        f.peer.buffer.sample(performance.now())!.sim_time_ns,
        100_000_000n,
      );
      assert.equal(
        f.peer.events.filter((event) => event === 'frame:3').length,
        1,
      );
      assert.equal(
        f.peer.events.filter((event) => event === 'welcome').length,
        1,
      );
    } finally {
      f.gateway.stop();
      f.peer.buffer.clear();
      late.buffer.clear();
    }
  });
}
test('near-soft 632-byte boundary retains paused status through a re-drain before the next tick', async () => {
  const f = await setup();
  try {
    await f.pauseBlocked();
    f.peer.crossSoftOnBoundary = true;
    f.peer.bufferedAmount = motionBudgets.softBytes - 100;
    await until(async () => f.peer.events.includes('paused'), Boolean);
    assert.equal(f.peer.crossedSoft, true);
    assert(f.peer.events.indexOf('frame:2') < f.peer.events.indexOf('paused'));
    assert.equal(
      f.peer.events.filter((event) => event === 'frame:2').length,
      1,
    );
    exactPause(f.peer);
  } finally {
    f.gateway.stop();
    f.peer.buffer.clear();
  }
});
test('an already delivered boundary is deduplicated when its paused status drains', async () => {
  const f = await setup(15);
  try {
    f.publisher.receive(frame(2n, 100_000_000n, 2));
    await until(async () => f.peer.events.includes('frame:2'), Boolean);
    f.peer.bufferedAmount = motionBudgets.softBytes + 1;
    f.state('paused');
    const read = f.peer.stateReads;
    await until(
      async () => f.peer.stateReads,
      (value) => value >= read + 3,
    );
    f.peer.bufferedAmount = 0;
    await until(async () => f.peer.events.includes('paused'), Boolean);
    assert.equal(
      f.peer.events.filter((event) => event === 'frame:2').length,
      1,
    );
    exactPause(f.peer);
  } finally {
    f.gateway.stop();
    f.peer.buffer.clear();
  }
});
test('Resume while blocked retains the pause pair then starts a new trusted segment', async () => {
  const f = await setup();
  try {
    await f.pauseBlocked();
    f.state('live');
    f.publisher.receive(frame(3n, 100_000_000n, 2));
    f.publisher.receive(frame(4n, 200_000_000n, 4));
    const read = f.peer.stateReads;
    await until(
      async () => f.peer.stateReads,
      (value) => value >= read + 3,
    );
    f.peer.bufferedAmount = 0;
    await until(async () => f.peer.events.includes('frame:4'), Boolean);
    const second = f.peer.events.indexOf('frame:2'),
      paused = f.peer.events.indexOf('paused'),
      resumed = f.peer.events.indexOf('live', paused),
      fourth = f.peer.events.indexOf('frame:4');
    assert(second < paused && paused < resumed && resumed < fourth);
    assert.deepEqual(f.peer.pausedSamples, [
      { sequence: 2n, time: 100_000_000n, x: 2 },
    ]);
    const sample = f.peer.buffer.sample(performance.now())!;
    assert.equal(sample.sequence, 4n);
    assert.equal(sample.sim_time_ns, 200_000_000n);
    assert.equal(sample.poses[0].position[0], 4);
    assert.equal(
      f.peer.events.filter((event) => event === 'frame:2').length,
      1,
    );
  } finally {
    f.gateway.stop();
    f.peer.buffer.clear();
  }
});
test('a persistently blocked Viewer disconnects under the existing slow-reader policy', async () => {
  const f = await setup(),
    fast = new BufferPeer();
  try {
    f.gateway.join(f.metadata, 'viewer', 30, fast, f.authority);
    await f.pauseBlocked();
    await until(async () => fast.events.includes('paused'), Boolean);
    exactPause(fast);
    await until(
      async () => f.peer.open,
      (value) => !value,
      motionBudgets.slowMillis + 1000,
    );
    assert.equal(f.peer.closeCode, 1008);
    assert.equal(f.peer.events.includes('paused'), false);
    assert.equal(f.peer.events.includes('frame:2'), false);
    assert.equal(fast.open, true);
  } finally {
    f.gateway.stop();
    f.peer.buffer.clear();
    fast.buffer.clear();
  }
});
