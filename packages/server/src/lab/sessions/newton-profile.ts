import profile from './newton-profile.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MotionPose } from '../../../../contracts/src/motion/index.ts';
import {
  NEWTON_POSE_KEYS,
  NEWTON_SCENE_VISUALS,
} from '../../../../contracts/src/motion/index.ts';
// Pin source bytes: JSON number spelling differs between Python and JavaScript.
const PROFILE_FILE_SHA256 =
  '68e126b2f3440fba8f99c8c04ee80b8522ba59c293f31554829b2391de539022';
if (
  createHash('sha256')
    .update(readFileSync(new URL('./newton-profile.json', import.meta.url)))
    .digest('hex') !== PROFILE_FILE_SHA256 ||
  profile.hash !==
    'sha256:c467d6b9f697882a30375f87e0ebbad30edb81708fb9310d87588329a417e9c0' ||
  profile.physics_archive.members.reduce(
    (total, member) => total + member.bytes,
    0,
  ) >
    20 * 1024 * 1024 ||
  profile.visuals.some(
    (visual, index) =>
      visual.sha256.slice(7) !== NEWTON_SCENE_VISUALS[index]?.sha256,
  )
)
  throw new Error('Fixed Newton profile/resource closure drift');
if (JSON.stringify(profile.body_order) !== JSON.stringify(NEWTON_POSE_KEYS))
  throw new Error('Fixed Newton public dictionary drift');

/** Authored FK, resource hashes and dynamics are fixed before any Publisher is admitted. */
export const newtonProfile = profile;
export function composePose(a: MotionPose, b: MotionPose): MotionPose {
  const [x, y, z, w] = a.quaternion,
    [X, Y, Z, W] = b.quaternion,
    [p, q, r] = b.position,
    tx = 2 * (y * r - z * q),
    ty = 2 * (z * p - x * r),
    tz = 2 * (x * q - y * p);
  return {
    position: [
      a.position[0] + p + w * tx + y * tz - z * ty,
      a.position[1] + q + w * ty + z * tx - x * tz,
      a.position[2] + r + w * tz + x * ty - y * tx,
    ],
    quaternion: [
      w * X + x * W + y * Z - z * Y,
      w * Y - x * Z + y * W + z * X,
      w * Z + x * Y - y * X + z * W,
      w * W - x * X - y * Y - z * Z,
    ],
  };
}
export function visualToBody(pose: MotionPose, index: number): MotionPose {
  const correction = profile.visuals[index].body_to_visual.position;
  return composePose(pose, {
    position: correction.map((v) => -v) as [number, number, number],
    quaternion: [0, 0, 0, 1],
  });
}
export function newtonInitialPoses(): MotionPose[] {
  return profile.initial_poses.map((pose) => ({
    position: pose.position as [number, number, number],
    quaternion: pose.quaternion as [number, number, number, number],
  }));
}
export function newtonVisualPoses(): MotionPose[] {
  return newtonInitialPoses().map((pose, index) => {
    const [x, y, z, w] = pose.quaternion,
      [a, b, c] = profile.visuals[index].body_to_visual.position,
      tx = 2 * (y * c - z * b),
      ty = 2 * (z * a - x * c),
      tz = 2 * (x * b - y * a);
    return {
      position: [
        pose.position[0] + a + w * tx + y * tz - z * ty,
        pose.position[1] + b + w * ty + z * tx - x * tz,
        pose.position[2] + c + w * tz + x * ty - y * tx,
      ],
      quaternion: pose.quaternion,
    };
  });
}
export function posePlacement(pose: MotionPose) {
  const [x, y, z, w] = pose.quaternion,
    m11 = 1 - 2 * (y * y + z * z),
    m12 = 2 * (x * y - z * w),
    m13 = 2 * (x * z + y * w),
    m22 = 1 - 2 * (x * x + z * z),
    m23 = 2 * (y * z - x * w),
    m32 = 2 * (y * z + x * w),
    m33 = 1 - 2 * (x * x + y * y),
    middle = Math.asin(Math.max(-1, Math.min(1, m13)));
  return {
    position: [...pose.position],
    rotation:
      Math.abs(m13) < 0.9999999
        ? [Math.atan2(-m23, m33), middle, Math.atan2(-m12, m11)]
        : [Math.atan2(m32, m22), middle, 0],
    scale: [1, 1, 1],
  };
}
