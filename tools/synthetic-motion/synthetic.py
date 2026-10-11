"""Deterministic fixture trajectory; no Newton installation or physics claim."""

import math
import re
from dataclasses import dataclass

from motion_codec import (MAX_BODIES, MAX_JOINTS, UUID, MotionProtocolError,
                          control_json, encode_snapshot, finite, utf8_size, validate_pose)

POSE_KEYS = [f'synthetic/body/{index:02d}' for index in range(20)]
JOINT_KEYS = [f'synthetic/joint/{index}' for index in range(6)]
RATE_HZ = 30


@dataclass(frozen=True)
class SyntheticStartup:
    url: str
    ticket: str
    session_id: str
    scene_hash: str
    body_order: tuple
    joint_order: tuple
    initial_poses: tuple
    initial_joints: tuple
    # Metres, radians/second, and radians for the fixed synthetic joint dictionary.
    translation_amplitude: float
    angular_speed: float
    joint_amplitude: float
    recording: dict | None = None


def parse_startup(text):
    """Owned stdin input, copied into immutable normalized body startup state."""
    value = control_json(text)

    def invalid(message):
        raise MotionProtocolError('invalid_message', message)

    if type(value.get('version')) is not int or value['version'] != 1:
        invalid('Unsupported synthetic startup version')
    if not isinstance(value.get('url'), str) or len(value['url']) > 2048:
        invalid('Invalid transport endpoint')
    if not isinstance(value.get('ticket'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,512}', value['ticket']):
        invalid('Invalid scoped ticket')
    if not isinstance(value.get('session_id'), str) or not UUID.fullmatch(value['session_id']):
        invalid('Invalid Session UUID')
    if not isinstance(value.get('scene_hash'), str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value['scene_hash']):
        invalid('Invalid scene hash')
    for name, bound in (('body_order', MAX_BODIES), ('joint_order', MAX_JOINTS)):
        keys = value.get(name)
        if not isinstance(keys, list) or len(keys) > bound:
            raise MotionProtocolError('limit_exceeded', 'Startup dictionary exceeds bounds')
        if any(not isinstance(key, str) or not key or utf8_size(key) > 128 for key in keys):
            invalid('Invalid startup key')
        if len(set(keys)) != len(keys):
            invalid('Startup keys must be unique')
    poses, joints = value.get('initial_poses'), value.get('initial_joints')
    if (not isinstance(poses, list) or len(poses) != len(value['body_order'])
            or not isinstance(joints, list) or len(joints) != len(value['joint_order'])):
        invalid('Startup state must match ordered dictionary')
    for pose in poses:
        if (not isinstance(pose, dict) or not isinstance(pose.get('position'), list)
                or not isinstance(pose.get('quaternion'), list)):
            invalid('Invalid initial pose')
        validate_pose(pose)
    for joint in joints:
        finite(joint)
    parameters = value.get('parameters')
    if not isinstance(parameters, dict):
        invalid('Expected actual synthetic parameters')
    for name in ('translation_amplitude', 'angular_speed', 'joint_amplitude'):
        finite(parameters.get(name), 10)
        if parameters[name] < 0:
            invalid('Synthetic parameters must be nonnegative')
    # Check the exact wire rounding as well as the persisted JSON values.
    encode_snapshot({'epoch': 0, 'sequence': 0, 'sim_time_ns': 0,
                     'mapping_revision': 0, 'poses': poses, 'joints': joints})
    from recording_codec import parse_bootstrap
    recording = parse_bootstrap(value['recording']) if 'recording' in value else None
    if recording is not None and (recording['session_id'] != value['session_id'] or recording['scene_hash'] != value['scene_hash']):
        invalid('Recording startup scope mismatch')
    return SyntheticStartup(value['url'], value['ticket'], value['session_id'], value['scene_hash'],
                            tuple(value['body_order']), tuple(value['joint_order']),
                            tuple((tuple(pose['position']), tuple(pose['quaternion'])) for pose in poses),
                            tuple(joints), **{name: parameters[name] for name in
                                              ('translation_amplitude', 'angular_speed', 'joint_amplitude')},
                            recording=recording)


def configured_snapshot(startup, epoch, sequence, sim_time_ns, mapping_revision):
    """Development trajectory with exact saved t=0 state; no physics claim."""
    t = sim_time_ns / 1_000_000_000
    poses = []
    angle = startup.angular_speed * t
    sine, cosine = math.sin(angle / 2), math.cos(angle / 2)
    for index, (position, quaternion) in enumerate(startup.initial_poses):
        phase = index * 0.2
        amplitude = startup.translation_amplitude
        x, y, z, w = quaternion
        poses.append({
            'position': [position[0] + amplitude * (math.sin(t + phase) - math.sin(phase)),
                         position[1] + amplitude / 3 * (math.sin(2 * t + phase) - math.sin(phase)),
                         position[2] + amplitude * (math.cos(t + phase) - math.cos(phase))],
            # Initial body quaternion × body-local Y rotation, XYZW.
            'quaternion': [x * cosine - z * sine, y * cosine + w * sine,
                           z * cosine + x * sine, w * cosine - y * sine],
        })
    return {'epoch': epoch, 'sequence': sequence, 'sim_time_ns': sim_time_ns,
            'mapping_revision': mapping_revision, 'poses': poses,
            'joints': [initial + startup.joint_amplitude * (math.sin(t + index * 0.2) - math.sin(index * 0.2))
                       for index, initial in enumerate(startup.initial_joints)]}


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
