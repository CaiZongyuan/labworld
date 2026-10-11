import type {
  MotionSnapshot,
  MotionWelcome,
} from '../../packages/contracts/src/motion/index';

export const motionWelcome: MotionWelcome = {
  type: 'motion.welcome',
  version: 1,
  codec: 'pose-f32-v1',
  session_id: '10000000-0000-0000-0000-000000000001',
  scene_hash: `sha256:${'a'.repeat(64)}`,
  epoch: '9007199254740993',
  mapping_revision: 1,
  coordinate_frame: 'rh-y-up-m',
  pose_keys: ['body-0'],
  joint_keys: ['joint-0'],
  targets: [
    {
      pose_key: 'body-0',
      node_id: '20000000-0000-0000-0000-000000000001',
      entity_id: '30000000-0000-0000-0000-000000000001',
      visual_target: 'node-root',
    },
  ],
  rate_hz: 30,
  simulation_rate: 1,
};
export function motionSnapshot(
  overrides: Partial<MotionSnapshot> = {},
): MotionSnapshot {
  return {
    epoch: BigInt(motionWelcome.epoch),
    mapping_revision: 1,
    sequence: 9007199254740993n,
    sim_time_ns: 9007199254740993n,
    poses: [{ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }],
    joints: [0],
    ...overrides,
  };
}
