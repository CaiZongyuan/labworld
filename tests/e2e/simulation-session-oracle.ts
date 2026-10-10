import assert from 'node:assert/strict';
import type {
  SimulationSession,
  SessionPose,
} from '../../packages/contracts/src/generated/types.gen';
import type { Diagnostic } from './motion-oracle';

// Frozen verification tolerances: f32 source values and <=250ms interpolation.
export const sessionPositionToleranceM = 0.0051;
export const sessionRotationToleranceRad = 0.0002;
export type SessionFrame = {
  epoch: string;
  sequence: string;
  sim_time_ns: string;
  mapping_revision: number;
  poses: SessionPose[];
  joints: number[];
};
const multiply = (a: number[], b: number[]) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const rotate = (v: number[], q: number[]) =>
  multiply(multiply(q, [...v, 0]), [-q[0], -q[1], -q[2], q[3]]).slice(0, 3);
export function configuredPose(
  session: SimulationSession,
  index: number,
  time: string,
): SessionPose {
  const t = Number(BigInt(time)) / 1e9,
    phase = index * 0.2;
  const initial = session.snapshot.initial_poses[index],
    parameters = session.snapshot.parameters;
  const angle = parameters.angular_speed * t;
  return {
    position: [
      initial.position[0] +
        parameters.translation_amplitude *
          (Math.sin(t + phase) - Math.sin(phase)),
      initial.position[1] +
        (parameters.translation_amplitude / 3) *
          (Math.sin(2 * t + phase) - Math.sin(phase)),
      initial.position[2] +
        parameters.translation_amplitude *
          (Math.cos(t + phase) - Math.cos(phase)),
    ],
    quaternion: multiply(initial.quaternion, [
      0,
      Math.sin(angle / 2),
      0,
      Math.cos(angle / 2),
    ]),
  };
}
export function visualPose(
  body: SessionPose,
  correction: SessionPose,
): SessionPose {
  const offset = rotate(correction.position, body.quaternion);
  return {
    position: body.position.map((v, i) => v + offset[i]),
    quaternion: multiply(body.quaternion, correction.quaternion),
  };
}
export function readSessionFrame(bytes: Buffer): SessionFrame {
  assert.equal(bytes.length, 632);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'LWM1');
  assert.equal(bytes[4], 1);
  assert.equal(bytes[5], 1);
  assert.equal(bytes.readUInt16LE(6), 0);
  assert.equal(bytes.readUInt32LE(36), 20);
  assert.equal(bytes.readUInt32LE(40), 6);
  assert.equal(bytes.readUInt32LE(44), 584);
  return {
    epoch: bytes.readBigUInt64LE(8).toString(),
    sequence: bytes.readBigUInt64LE(16).toString(),
    sim_time_ns: bytes.readBigUInt64LE(24).toString(),
    mapping_revision: bytes.readUInt32LE(32),
    poses: Array.from({ length: 20 }, (_, i) => ({
      position: Array.from({ length: 3 }, (_, axis) =>
        bytes.readFloatLE(48 + i * 28 + axis * 4),
      ),
      quaternion: Array.from({ length: 4 }, (_, axis) =>
        bytes.readFloatLE(60 + i * 28 + axis * 4),
      ),
    })),
    joints: Array.from({ length: 6 }, (_, i) => bytes.readFloatLE(608 + i * 4)),
  };
}
export function assertSessionFrame(
  session: SimulationSession,
  frame: SessionFrame,
) {
  assert.equal(frame.epoch, session.epoch);
  assert.equal(
    frame.mapping_revision,
    session.snapshot.installation.mapping_revision,
  );
  for (let i = 0; i < 20; i++) {
    const expected = configuredPose(session, i, frame.sim_time_ns);
    for (let axis = 0; axis < 3; axis++)
      assert(
        Math.abs(frame.poses[i].position[axis] - expected.position[axis]) <=
          0.000001,
      );
    for (let axis = 0; axis < 4; axis++)
      assert(
        Math.abs(frame.poses[i].quaternion[axis] - expected.quaternion[axis]) <=
          0.000001,
      );
  }
  for (let i = 0; i < 6; i++) {
    const t = Number(BigInt(frame.sim_time_ns)) / 1e9;
    const expected =
      session.snapshot.initial_joints[i] +
      session.snapshot.parameters.joint_amplitude *
        (Math.sin(t + i * 0.2) - Math.sin(i * 0.2));
    assert(Math.abs(frame.joints[i] - expected) <= 0.000001);
  }
}
export function assertSessionGeometry(
  value: Diagnostic,
  session: SimulationSession,
  boundary?: SessionFrame,
) {
  assert.equal(value.session_id, session.id);
  assert.equal(value.epoch, session.epoch);
  assert.equal(
    value.mapping_revision,
    session.snapshot.installation.mapping_revision,
  );
  assert.equal(value.nodes.length, 20);
  let maximumPositionError = 0,
    maximumRotationError = 0;
  for (const node of value.nodes) {
    const i = session.snapshot.installation.targets.findIndex(
      (target) => target.node_id === node.node_id,
    );
    assert(i >= 0);
    const target = session.snapshot.installation.targets[i];
    assert.equal(node.entity_id, target.entity_id);
    assert.equal(node.pose_key, target.pose_key);
    if (boundary) {
      assert.equal(node.sequence, boundary.sequence);
      assert.equal(node.sim_time_ns, boundary.sim_time_ns);
    }
    const expected = visualPose(
      configuredPose(session, i, node.sim_time_ns),
      target.body_to_visual,
    );
    for (let axis = 0; axis < 3; axis++) {
      const error = Math.abs(node.position[axis] - expected.position[axis]);
      maximumPositionError = Math.max(maximumPositionError, error);
      assert(error <= sessionPositionToleranceM);
    }
    const norm = Math.hypot(...node.quaternion);
    assert(Math.abs(norm - 1) <= 0.00001);
    const dot = node.quaternion.reduce(
      (sum, v, axis) => sum + v * expected.quaternion[axis],
      0,
    );
    const angle = 2 * Math.acos(Math.min(1, Math.abs(dot) / norm));
    maximumRotationError = Math.max(maximumRotationError, angle);
    assert(angle <= sessionRotationToleranceRad);
  }
  return {
    maximumPositionError,
    maximumRotationError,
    boundarySequence: boundary?.sequence ?? null,
    boundarySimTimeNs: boundary?.sim_time_ns ?? null,
  };
}
