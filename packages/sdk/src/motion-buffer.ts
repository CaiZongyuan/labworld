import type {
  MotionSnapshot,
  MotionWelcome,
} from '@labos-threejs/contracts/motion';

export type MotionSample = {
  poses: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
  }[];
  joints: number[];
  sim_time_ns: bigint;
  sequence: bigint;
};

/** A small receive-clock buffer. It never predicts past a complete snapshot. */
export class MotionBuffer {
  readonly delayMs = 100;
  readonly staleMs = 500;
  readonly maxGapMs = 250;
  readonly maxFrames = 8;
  private frames: MotionSnapshot[] = [];
  private anchor: { received: number; time: bigint } | null = null;
  private lastReceived = -Infinity;
  private lastSequence = -1n;
  private output: MotionSample | null = null;
  private metadata: MotionWelcome | null = null;
  private stopped = false;

  get welcome() {
    return this.metadata;
  }
  get size() {
    return this.frames.length;
  }

  freeze() {
    this.stopped = true;
  }

  configure(welcome: MotionWelcome) {
    this.clear();
    this.metadata = welcome;
    this.output = {
      poses: welcome.pose_keys.map(() => ({
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
      })),
      joints: welcome.joint_keys.map(() => 0),
      sim_time_ns: 0n,
      sequence: 0n,
    };
  }

  clear() {
    this.frames = [];
    this.anchor = null;
    this.metadata = null;
    this.output = null;
    this.lastSequence = -1n;
    this.lastReceived = -Infinity;
    this.stopped = false;
  }

  push(snapshot: MotionSnapshot, received: number): boolean {
    const welcome = this.metadata;
    if (
      !welcome ||
      !Number.isFinite(received) ||
      received < this.lastReceived ||
      snapshot.epoch !== BigInt(welcome.epoch) ||
      snapshot.mapping_revision !== welcome.mapping_revision ||
      snapshot.poses.length !== welcome.pose_keys.length ||
      snapshot.joints.length !== welcome.joint_keys.length ||
      snapshot.sequence <= this.lastSequence
    )
      return false;
    const previous = this.frames.at(-1);
    // A new segment starts at the new trusted frame, never between old and new data.
    if (
      this.stopped ||
      !previous ||
      received - this.lastReceived > this.maxGapMs ||
      snapshot.sim_time_ns <= previous.sim_time_ns ||
      snapshot.sim_time_ns - previous.sim_time_ns >
        BigInt(this.maxGapMs * 1_000_000)
    ) {
      this.frames = [];
      this.anchor = { received, time: snapshot.sim_time_ns };
      this.copy(snapshot);
    }
    this.frames.push(snapshot);
    this.stopped = false;
    if (this.frames.length > this.maxFrames) this.frames.shift();
    this.lastSequence = snapshot.sequence;
    this.lastReceived = received;
    return true;
  }

  freshness(now: number): 'waiting' | 'live' | 'stale' {
    if (!this.frames.length) return 'waiting';
    return now - this.lastReceived > this.staleMs ? 'stale' : 'live';
  }

  sample(now: number): MotionSample | null {
    if (!this.anchor || !this.output || !this.frames.length) return null;
    if (this.stopped || this.freshness(now) === 'stale') return this.output;
    const elapsed = Math.max(0, now - this.anchor.received - this.delayMs);
    const target =
      this.anchor.time +
      BigInt(Math.round(elapsed * 1_000_000 * this.metadata!.simulation_rate));
    while (this.frames.length > 2 && this.frames[1].sim_time_ns <= target)
      this.frames.shift();
    const before = this.frames[0];
    const after = this.frames[1];
    if (!after || target <= before.sim_time_ns) {
      this.copy(before);
      return this.output;
    }
    if (target >= after.sim_time_ns) {
      this.copy(after);
      return this.output;
    }
    const mix =
      Number(target - before.sim_time_ns) /
      Number(after.sim_time_ns - before.sim_time_ns);
    for (let i = 0; i < this.output.poses.length; i++) {
      const a = before.poses[i],
        b = after.poses[i],
        pose = this.output.poses[i];
      for (let j = 0; j < 3; j++)
        pose.position[j] =
          a.position[j] + (b.position[j] - a.position[j]) * mix;
      slerp(a.quaternion, b.quaternion, mix, pose.quaternion);
    }
    for (let i = 0; i < this.output.joints.length; i++)
      this.output.joints[i] =
        before.joints[i] + (after.joints[i] - before.joints[i]) * mix;
    this.output.sim_time_ns = target;
    this.output.sequence = after.sequence;
    return this.output;
  }

  private copy(snapshot: MotionSnapshot) {
    if (!this.output) return;
    for (let i = 0; i < snapshot.poses.length; i++) {
      const pose = this.output.poses[i];
      for (let j = 0; j < 3; j++)
        pose.position[j] = snapshot.poses[i].position[j];
      for (let j = 0; j < 4; j++)
        pose.quaternion[j] = snapshot.poses[i].quaternion[j];
    }
    for (let i = 0; i < snapshot.joints.length; i++)
      this.output.joints[i] = snapshot.joints[i];
    this.output.sim_time_ns = snapshot.sim_time_ns;
    this.output.sequence = snapshot.sequence;
  }
}

function slerp(
  a: readonly number[],
  b: readonly number[],
  mix: number,
  out: number[],
) {
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a[i] * b[i];
  const direction = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  const angle = Math.acos(dot);
  const sine = Math.sin(angle);
  const wa = sine > 0.001 ? Math.sin((1 - mix) * angle) / sine : 1 - mix;
  const wb = sine > 0.001 ? Math.sin(mix * angle) / sine : mix;
  let norm = 0;
  for (let i = 0; i < 4; i++) {
    out[i] = wa * a[i] + wb * direction * b[i];
    norm += out[i] ** 2;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 4; i++) out[i] /= norm;
}
