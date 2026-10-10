/** Handwritten motion v1 contract. HTTP DTO generation does not own this file. */
export const MOTION_VERSION = 1;
export const MOTION_CODEC = 'pose-f32-v1';
export const MOTION_HEADER_BYTES = 48;
export const MOTION_LIMITS = Object.freeze({
  bodies: 1024,
  joints: 1024,
  binary_bytes: 64 * 1024,
  control_bytes: 256 * 1024,
  hello_bytes: 4096,
  session_control_bytes: 4096,
  coordinate_abs: 10_000,
  joint_abs: 10_000,
  quaternion_norm_tolerance: 0.001,
  key_bytes: 128,
});

export type MotionRate = 15 | 30;
export type MotionPosition = readonly [number, number, number];
export type MotionQuaternion = readonly [number, number, number, number];
export interface MotionPose {
  position: MotionPosition;
  /** Right handed, Y up, metres; quaternion components are XYZW. */
  quaternion: MotionQuaternion;
}
export interface MotionSnapshot {
  epoch: bigint;
  sequence: bigint;
  sim_time_ns: bigint;
  mapping_revision: number;
  poses: readonly MotionPose[];
  joints: readonly number[];
}
export interface MotionExpectedMapping {
  epoch?: bigint;
  mapping_revision: number;
  body_count: number;
  joint_count: number;
}

interface MotionHelloBase {
  type: 'motion.hello';
  version: 1;
  session_id: string;
  codec: typeof MOTION_CODEC;
  ticket: string;
  preferred_rate_hz: MotionRate;
}
export type MotionHello =
  | (MotionHelloBase & { role: 'viewer' })
  | (MotionHelloBase & { role: 'publisher'; scene_hash: string });

export interface MotionTarget {
  pose_key: string;
  entity_id: string;
  node_id: string;
  /** World pose of the Scene Node root; centered GLB offsets remain child local. */
  visual_target: 'node-root';
  /** Normalized body world pose × this correction = visual node-root world pose. */
  body_to_visual?: MotionPose;
}
export interface MotionWelcome {
  type: 'motion.welcome';
  version: 1;
  session_id: string;
  scene_hash: string;
  /** Canonical decimal u64. JSON does not carry BigInt. */
  epoch: string;
  mapping_revision: number;
  codec: typeof MOTION_CODEC;
  coordinate_frame: 'rh-y-up-m';
  pose_keys: readonly string[];
  joint_keys: readonly string[];
  targets: readonly MotionTarget[];
  rate_hz: MotionRate;
  simulation_rate: 1;
}
export const MOTION_ERROR_CODES = [
  'invalid_message',
  'invalid_magic',
  'unsupported_version',
  'invalid_flags',
  'invalid_length',
  'limit_exceeded',
  'invalid_number',
  'invalid_quaternion',
  'invalid_u64',
  'mapping_mismatch',
  'epoch_mismatch',
  'sequence_rejected',
  'unauthorized',
  'publisher_conflict',
  'rate_exceeded',
  'session_closed',
] as const;
export type MotionErrorCode = (typeof MOTION_ERROR_CODES)[number];
export interface MotionErrorMessage {
  type: 'motion.error';
  code: MotionErrorCode;
  message: string;
}
export interface MotionStatus {
  type: 'motion.status';
  state: 'waiting' | 'live' | 'stale' | 'paused' | 'interrupted' | 'closed';
  rate_hz: MotionRate;
}
export type MotionControl = MotionWelcome | MotionErrorMessage | MotionStatus;

export type MotionSessionAction = 'pause' | 'resume' | 'stop';
interface MotionSessionBoundary {
  session_id: string;
  /** Canonical decimal u64 allocated by the Session authority. */
  epoch: string;
  transition_id: string;
  revision: number;
  action: MotionSessionAction;
}
/** Publisher-only request; viewers never receive or execute this message. */
export interface MotionSessionControl extends MotionSessionBoundary {
  type: 'motion.session_control';
}
/** Sent after its complete boundary frame on the same ordered connection. */
export interface MotionSessionAck extends MotionSessionBoundary {
  type: 'motion.session_ack';
  result: 'applied';
  last_sequence: string;
  sim_time_ns: string;
}

export class MotionProtocolError extends Error {
  readonly code: MotionErrorCode;
  constructor(code: MotionErrorCode, message: string) {
    super(message);
    this.name = 'MotionProtocolError';
    this.code = code;
  }
}
