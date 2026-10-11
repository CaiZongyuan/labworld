"""Deterministic fixture trajectory; no Newton installation or physics claim."""

import math

POSE_KEYS = [f'synthetic/body/{index:02d}' for index in range(20)]
JOINT_KEYS = [f'synthetic/joint/{index}' for index in range(6)]
RATE_HZ = 30


def synthetic_snapshot(epoch, sequence, sim_time_ns, mapping_revision):
    t = sim_time_ns / 1_000_000_000
    poses = []
    for index in range(20):
        phase = index * 0.2
        yaw = 0.4 * t + index * 0.1
        poses.append({
            'position': [(index % 5 - 2) * 1.6 + 0.45 * math.sin(t + phase),
                         0.65 + 0.15 * math.sin(2 * t + phase),
                         (index // 5 - 1.5) * 1.4 + 0.35 * math.cos(t + phase)],
            'quaternion': [0, math.sin(yaw / 2), 0, math.cos(yaw / 2)],
        })
    return {'epoch': epoch, 'sequence': sequence, 'sim_time_ns': sim_time_ns,
            'mapping_revision': mapping_revision, 'poses': poses,
            'joints': [0.5 * math.sin(t + index * 0.2) for index in range(6)]}
