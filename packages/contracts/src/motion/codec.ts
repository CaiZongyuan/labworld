import {
  MOTION_HEADER_BYTES,
  MOTION_LIMITS,
  MotionProtocolError,
  type MotionExpectedMapping,
  type MotionPose,
  type MotionSnapshot,
} from './types.ts';

const U64_MAX = (1n << 64n) - 1n;
export function parseMotionU64(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value))
    throw new MotionProtocolError(
      'invalid_u64',
      'Expected canonical decimal u64',
    );
  const integer = BigInt(value);
  validateU64(integer);
  return integer;
}
function validateU64(value: bigint) {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX)
    throw new MotionProtocolError('invalid_u64', 'Integer is outside u64');
}
function validateMappingRevision(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new MotionProtocolError(
      'mapping_mismatch',
      'Invalid mapping revision',
    );
}
function payloadSize(bodies: number, joints: number) {
  if (
    !Number.isInteger(bodies) ||
    !Number.isInteger(joints) ||
    bodies < 0 ||
    joints < 0 ||
    bodies > MOTION_LIMITS.bodies ||
    joints > MOTION_LIMITS.joints
  )
    throw new MotionProtocolError(
      'limit_exceeded',
      'Motion dictionary exceeds bounds',
    );
  return bodies * 28 + joints * 4;
}
function finiteBounded(value: number, bound: number) {
  if (!Number.isFinite(value) || Math.abs(value) > bound)
    throw new MotionProtocolError(
      'invalid_number',
      'Nonfinite or unbounded motion value',
    );
}
function validatePose(pose: MotionPose) {
  if (pose.position.length !== 3 || pose.quaternion.length !== 4)
    throw new MotionProtocolError(
      'invalid_length',
      'Invalid pose component count',
    );
  for (const value of pose.position)
    finiteBounded(value, MOTION_LIMITS.coordinate_abs);
  for (const value of pose.quaternion)
    finiteBounded(value, 1 + MOTION_LIMITS.quaternion_norm_tolerance);
  const norm = Math.hypot(...pose.quaternion);
  if (Math.abs(norm - 1) > MOTION_LIMITS.quaternion_norm_tolerance)
    throw new MotionProtocolError(
      'invalid_quaternion',
      'Quaternion must have unit norm within tolerance',
    );
}

export function encodeMotionSnapshot(snapshot: MotionSnapshot): Uint8Array {
  validateU64(snapshot.epoch);
  validateU64(snapshot.sequence);
  validateU64(snapshot.sim_time_ns);
  validateMappingRevision(snapshot.mapping_revision);
  const payload = payloadSize(snapshot.poses.length, snapshot.joints.length);
  const bytes = new Uint8Array(MOTION_HEADER_BYTES + payload);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x57, 0x4d, 0x31, 1, 1, 0, 0]);
  view.setBigUint64(8, snapshot.epoch, true);
  view.setBigUint64(16, snapshot.sequence, true);
  view.setBigUint64(24, snapshot.sim_time_ns, true);
  view.setUint32(32, snapshot.mapping_revision, true);
  view.setUint32(36, snapshot.poses.length, true);
  view.setUint32(40, snapshot.joints.length, true);
  view.setUint32(44, payload, true);
  let offset = MOTION_HEADER_BYTES;
  for (const pose of snapshot.poses) {
    validatePose(pose);
    for (const value of [...pose.position, ...pose.quaternion]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
  }
  for (const value of snapshot.joints) {
    finiteBounded(value, MOTION_LIMITS.joint_abs);
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  // Enforce the same bounds after f32 rounding; do not emit a frame the reader rejects.
  decodeMotionSnapshot(bytes);
  return bytes;
}

export function decodeMotionSnapshot(
  bytes: ArrayBuffer | ArrayBufferView,
  expected?: MotionExpectedMapping,
): MotionSnapshot {
  const view = ArrayBuffer.isView(bytes)
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
  if (view.byteLength > MOTION_LIMITS.binary_bytes)
    throw new MotionProtocolError(
      'limit_exceeded',
      'Motion message exceeds byte budget',
    );
  if (view.byteLength < MOTION_HEADER_BYTES)
    throw new MotionProtocolError('invalid_length', 'Truncated motion header');
  if (view.getUint32(0, false) !== 0x4c574d31)
    throw new MotionProtocolError('invalid_magic', 'Expected LWM1');
  if (view.getUint8(4) !== 1 || view.getUint8(5) !== 1)
    throw new MotionProtocolError(
      'unsupported_version',
      'Unsupported motion version or message type',
    );
  if (view.getUint16(6, true) !== 0)
    throw new MotionProtocolError(
      'invalid_flags',
      'Motion v1 flags must be zero',
    );
  const epoch = view.getBigUint64(8, true);
  const sequence = view.getBigUint64(16, true);
  const sim_time_ns = view.getBigUint64(24, true);
  const mapping_revision = view.getUint32(32, true);
  const body_count = view.getUint32(36, true);
  const joint_count = view.getUint32(40, true);
  const payload = payloadSize(body_count, joint_count);
  if (
    view.getUint32(44, true) !== payload ||
    view.byteLength !== MOTION_HEADER_BYTES + payload
  )
    throw new MotionProtocolError(
      'invalid_length',
      'Motion payload length must match full snapshot',
    );
  if (expected) {
    validateMappingRevision(expected.mapping_revision);
    payloadSize(expected.body_count, expected.joint_count);
    if (
      mapping_revision !== expected.mapping_revision ||
      body_count !== expected.body_count ||
      joint_count !== expected.joint_count
    )
      throw new MotionProtocolError(
        'mapping_mismatch',
        'Snapshot does not match immutable dictionary',
      );
    if (expected.epoch !== undefined) {
      validateU64(expected.epoch);
      if (epoch !== expected.epoch)
        throw new MotionProtocolError(
          'epoch_mismatch',
          'Snapshot epoch does not match admission',
        );
    }
  }
  let offset = MOTION_HEADER_BYTES;
  function float() {
    const value = view.getFloat32(offset, true);
    offset += 4;
    return value;
  }
  const poses: MotionPose[] = [];
  for (let i = 0; i < body_count; i++) {
    const pose: MotionPose = {
      position: [float(), float(), float()],
      quaternion: [float(), float(), float(), float()],
    };
    validatePose(pose);
    poses.push(pose);
  }
  const joints: number[] = [];
  for (let i = 0; i < joint_count; i++) {
    const value = float();
    finiteBounded(value, MOTION_LIMITS.joint_abs);
    joints.push(value);
  }
  return { epoch, sequence, sim_time_ns, mapping_revision, poses, joints };
}
