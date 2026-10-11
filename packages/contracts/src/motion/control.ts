import { encodeMotionSnapshot, parseMotionU64 } from './codec.ts';
import {
  MOTION_CODEC,
  MOTION_ERROR_CODES,
  MOTION_LIMITS,
  MotionProtocolError,
  type MotionControl,
  type MotionHello,
  type MotionPose,
  type MotionRate,
  type MotionSessionAck,
  type MotionSessionControl,
  type MotionTarget,
  type MotionWelcome,
} from './types.ts';

const utf8 = new TextEncoder();
function invalid(message: string): never {
  throw new MotionProtocolError('invalid_message', message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Expected motion JSON object');
  return value as Record<string, unknown>;
}
function json(text: string, budget: number) {
  if (typeof text !== 'string') invalid('Expected JSON text');
  if (text.length > budget || utf8.encode(text).byteLength > budget)
    throw new MotionProtocolError(
      'limit_exceeded',
      'Motion JSON exceeds byte budget',
    );
  try {
    return record(JSON.parse(text));
  } catch (error) {
    if (error instanceof MotionProtocolError) throw error;
    return invalid('Invalid motion JSON');
  }
}
function text(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    /[\uD800-\uDFFF]/u.test(value) ||
    utf8.encode(value).byteLength > maxBytes
  )
    invalid('Invalid motion string');
  return value;
}
function uuid(value: unknown): string {
  const id = text(value, 36);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    invalid('Invalid UUID');
  return id;
}
function sceneHash(value: unknown): string {
  const hash = text(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) invalid('Invalid scene hash');
  return hash;
}
function rate(value: unknown): MotionRate {
  if (value !== 15 && value !== 30) invalid('Motion rate must be 15 or 30 Hz');
  return value;
}
function revision(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  )
    invalid('Invalid mapping revision');
  return value;
}
function envelope(value: Record<string, unknown>, type: string) {
  if (value.type !== type) invalid(`Expected ${type}`);
  if (value.version !== 1 || value.codec !== MOTION_CODEC)
    throw new MotionProtocolError(
      'unsupported_version',
      'Unsupported motion control version or codec',
    );
}
function keys(value: unknown, maxCount: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxCount)
    throw new MotionProtocolError(
      'limit_exceeded',
      'Motion dictionary exceeds bounds',
    );
  const result = value.map((key) => text(key, MOTION_LIMITS.key_bytes));
  if (new Set(result).size !== result.length)
    invalid('Motion dictionary keys must be unique');
  return Object.freeze(result);
}

function pose(value: unknown): MotionPose {
  const item = record(value);
  if (
    !Array.isArray(item.position) ||
    item.position.length !== 3 ||
    !Array.isArray(item.quaternion) ||
    item.quaternion.length !== 4
  )
    invalid('Invalid correction pose');
  const result: MotionPose = {
    position: [item.position[0], item.position[1], item.position[2]],
    quaternion: [
      item.quaternion[0],
      item.quaternion[1],
      item.quaternion[2],
      item.quaternion[3],
    ],
  };
  encodeMotionSnapshot({
    epoch: 0n,
    sequence: 0n,
    sim_time_ns: 0n,
    mapping_revision: 0,
    poses: [result],
    joints: [],
  });
  Object.freeze(result.position);
  Object.freeze(result.quaternion);
  return Object.freeze(result);
}

export function parseMotionHello(input: string): MotionHello {
  const value = json(input, MOTION_LIMITS.hello_bytes);
  envelope(value, 'motion.hello');
  const ticket = text(value.ticket, 512);
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(ticket)) invalid('Invalid scoped ticket');
  const common = {
    type: 'motion.hello' as const,
    version: 1 as const,
    session_id: uuid(value.session_id),
    codec: MOTION_CODEC,
    ticket,
    preferred_rate_hz: rate(value.preferred_rate_hz),
  } as const;
  if (value.role === 'viewer') return { ...common, role: 'viewer' };
  if (value.role === 'publisher')
    return {
      ...common,
      role: 'publisher',
      scene_hash: sceneHash(value.scene_hash),
    };
  return invalid('Unsupported motion role');
}

function welcome(value: Record<string, unknown>): MotionWelcome {
  envelope(value, 'motion.welcome');
  const epoch = text(value.epoch, 20);
  parseMotionU64(epoch);
  const pose_keys = keys(value.pose_keys, MOTION_LIMITS.bodies);
  const joint_keys = keys(value.joint_keys, MOTION_LIMITS.joints);
  if (
    !Array.isArray(value.targets) ||
    value.targets.length !== pose_keys.length
  )
    invalid('Every pose key requires one ordered visual target');
  const targets = value.targets.map((entry, index): MotionTarget => {
    const target = record(entry);
    if (
      target.pose_key !== pose_keys[index] ||
      target.visual_target !== 'node-root'
    )
      invalid('Visual target must match ordered pose key and node root');
    return Object.freeze({
      pose_key: pose_keys[index],
      entity_id: uuid(target.entity_id),
      node_id: uuid(target.node_id),
      visual_target: 'node-root',
      ...(target.body_to_visual === undefined
        ? {}
        : { body_to_visual: pose(target.body_to_visual) }),
    });
  });
  if (new Set(targets.map((target) => target.node_id)).size !== targets.length)
    invalid('Multiple poses cannot target the same Scene Node root');
  if (value.coordinate_frame !== 'rh-y-up-m' || value.simulation_rate !== 1)
    invalid('Unsupported coordinate frame or simulation rate');
  return Object.freeze({
    type: 'motion.welcome',
    version: 1,
    session_id: uuid(value.session_id),
    scene_hash: sceneHash(value.scene_hash),
    epoch,
    mapping_revision: revision(value.mapping_revision),
    codec: MOTION_CODEC,
    coordinate_frame: 'rh-y-up-m',
    pose_keys,
    joint_keys,
    targets: Object.freeze(targets),
    rate_hz: rate(value.rate_hz),
    simulation_rate: 1,
  });
}
export function parseMotionWelcome(input: string): MotionWelcome {
  return welcome(json(input, MOTION_LIMITS.control_bytes));
}
export function parseMotionControl(input: string): MotionControl {
  const value = json(input, MOTION_LIMITS.control_bytes);
  if (value.type === 'motion.welcome') return welcome(value);
  if (value.type === 'motion.error') {
    const code = MOTION_ERROR_CODES.find((code) => code === value.code);
    if (!code) invalid('Invalid motion error code');
    return { type: 'motion.error', code, message: text(value.message, 256) };
  }
  if (value.type === 'motion.status') {
    const state = [
      'waiting',
      'live',
      'stale',
      'paused',
      'interrupted',
      'closed',
    ] as const;
    const selected = state.find((state) => state === value.state);
    if (!selected) invalid('Invalid motion status');
    return {
      type: 'motion.status',
      state: selected,
      rate_hz: rate(value.rate_hz),
    };
  }
  return invalid('Unsupported server motion control');
}

function sessionBoundary(value: Record<string, unknown>) {
  const epoch = text(value.epoch, 20);
  parseMotionU64(epoch);
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    invalid('Invalid Session revision');
  const action = (['pause', 'resume', 'stop'] as const).find(
    (action) => action === value.action,
  );
  if (!action) invalid('Invalid Session action');
  return {
    session_id: uuid(value.session_id),
    epoch,
    transition_id: uuid(value.transition_id),
    revision: value.revision,
    action,
  };
}

export function parseMotionSessionControl(input: string): MotionSessionControl {
  const value = json(input, MOTION_LIMITS.session_control_bytes);
  if (value.type !== 'motion.session_control')
    invalid('Expected motion.session_control');
  return { type: 'motion.session_control', ...sessionBoundary(value) };
}

export function parseMotionSessionAck(input: string): MotionSessionAck {
  const value = json(input, MOTION_LIMITS.session_control_bytes);
  if (value.type !== 'motion.session_ack' || value.result !== 'applied')
    invalid('Expected applied motion.session_ack');
  const last_sequence = text(value.last_sequence, 20);
  const sim_time_ns = text(value.sim_time_ns, 20);
  parseMotionU64(last_sequence);
  parseMotionU64(sim_time_ns);
  return {
    type: 'motion.session_ack',
    ...sessionBoundary(value),
    result: 'applied',
    last_sequence,
    sim_time_ns,
  };
}
