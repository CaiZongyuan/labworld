"""Standard-library LWM1 codec. No physics or WebSocket dependency is required."""

import json
import math
import re
import struct
import sys

HEADER = struct.Struct('<4sBBHQQQIIII')
POSE = struct.Struct('<7f')
U64_MAX = (1 << 64) - 1
MAX_BODIES = MAX_JOINTS = 1024
MAX_BINARY_BYTES = 64 * 1024
MAX_CONTROL_BYTES = 256 * 1024
MAX_SESSION_CONTROL_BYTES = 4096
MAX_ABS = 10_000
QUATERNION_TOLERANCE = 0.001
CODEC = 'pose-f32-v1'
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$', re.I)


class MotionProtocolError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def u64(value):
    if type(value) is not int or not 0 <= value <= U64_MAX:
        raise MotionProtocolError('invalid_u64', 'Integer is outside u64')
    return value


def parse_u64(value):
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', value):
        raise MotionProtocolError('invalid_u64', 'Expected canonical decimal u64')
    return u64(int(value))


def revision(value):
    if type(value) is not int or not 0 <= value <= 0xffffffff:
        raise MotionProtocolError('mapping_mismatch', 'Invalid mapping revision')
    return value


def payload_size(bodies, joints):
    if (type(bodies) is not int or type(joints) is not int
            or not 0 <= bodies <= MAX_BODIES or not 0 <= joints <= MAX_JOINTS):
        raise MotionProtocolError('limit_exceeded', 'Motion dictionary exceeds bounds')
    return bodies * 28 + joints * 4


def finite(value, bound=MAX_ABS):
    if type(value) not in (int, float) or abs(value) > bound or not math.isfinite(value):
        raise MotionProtocolError('invalid_number', 'Nonfinite or unbounded motion value')


def validate_pose(pose):
    position, quaternion = pose['position'], pose['quaternion']
    if len(position) != 3 or len(quaternion) != 4:
        raise MotionProtocolError('invalid_length', 'Invalid pose component count')
    for value in position:
        finite(value)
    for value in quaternion:
        finite(value, 1 + QUATERNION_TOLERANCE)
    if abs(math.hypot(*quaternion) - 1) > QUATERNION_TOLERANCE:
        raise MotionProtocolError('invalid_quaternion', 'Quaternion must have unit norm within tolerance')


def encode_snapshot(snapshot):
    poses, joints = snapshot['poses'], snapshot['joints']
    payload = payload_size(len(poses), len(joints))
    header = HEADER.pack(b'LWM1', 1, 1, 0, u64(snapshot['epoch']),
                         u64(snapshot['sequence']), u64(snapshot['sim_time_ns']),
                         revision(snapshot['mapping_revision']), len(poses), len(joints), payload)
    parts = [header]
    for pose in poses:
        validate_pose(pose)
        parts.append(POSE.pack(*pose['position'], *pose['quaternion']))
    for value in joints:
        finite(value)
        parts.append(struct.pack('<f', value))
    result = b''.join(parts)
    # Enforce bounds after f32 rounding, matching the TypeScript reader.
    decode_snapshot(result)
    return result


def decode_snapshot(data, expected=None):
    data = memoryview(data)
    if data.nbytes > MAX_BINARY_BYTES:
        raise MotionProtocolError('limit_exceeded', 'Motion message exceeds byte budget')
    if data.nbytes < HEADER.size:
        raise MotionProtocolError('invalid_length', 'Truncated motion header')
    magic, version, kind, flags, epoch, sequence, sim_time_ns, mapping_revision, bodies, joints, payload = HEADER.unpack_from(data)
    if magic != b'LWM1':
        raise MotionProtocolError('invalid_magic', 'Expected LWM1')
    if version != 1 or kind != 1:
        raise MotionProtocolError('unsupported_version', 'Unsupported motion version or message type')
    if flags != 0:
        raise MotionProtocolError('invalid_flags', 'Motion v1 flags must be zero')
    size = payload_size(bodies, joints)
    if payload != size or data.nbytes != HEADER.size + size:
        raise MotionProtocolError('invalid_length', 'Motion payload length must match full snapshot')
    if expected is not None:
        revision(expected['mapping_revision'])
        payload_size(expected['body_count'], expected['joint_count'])
        if (mapping_revision != expected['mapping_revision']
                or bodies != expected['body_count'] or joints != expected['joint_count']):
            raise MotionProtocolError('mapping_mismatch', 'Snapshot does not match immutable dictionary')
        if 'epoch' in expected and epoch != u64(expected['epoch']):
            raise MotionProtocolError('epoch_mismatch', 'Snapshot epoch does not match admission')
    poses = []
    offset = HEADER.size
    for _ in range(bodies):
        values = POSE.unpack_from(data, offset)
        offset += POSE.size
        pose = {'position': list(values[:3]), 'quaternion': list(values[3:])}
        validate_pose(pose)
        poses.append(pose)
    joint_values = []
    for _ in range(joints):
        value, = struct.unpack_from('<f', data, offset)
        offset += 4
        finite(value)
        joint_values.append(value)
    return {'epoch': epoch, 'sequence': sequence, 'sim_time_ns': sim_time_ns,
            'mapping_revision': mapping_revision, 'poses': poses, 'joints': joint_values}


def utf8_size(value):
    try:
        return len(value.encode('utf-8'))
    except UnicodeError as error:
        raise MotionProtocolError('invalid_message', 'Invalid Unicode string') from error


def control_json(text, budget=MAX_CONTROL_BYTES):
    if not isinstance(text, str):
        raise MotionProtocolError('invalid_message', 'Expected motion JSON text')
    if len(text) > budget or utf8_size(text) > budget:
        raise MotionProtocolError('limit_exceeded', 'Motion JSON exceeds byte budget')
    def reject_constant(_):
        raise ValueError('Non-JSON numeric constant')

    try:
        value = json.loads(text, parse_constant=reject_constant)
    except (ValueError, RecursionError) as error:
        raise MotionProtocolError('invalid_message', 'Invalid motion JSON') from error
    if not isinstance(value, dict):
        raise MotionProtocolError('invalid_message', 'Expected motion JSON object')
    return value


def parse_welcome(text):
    value = control_json(text)

    def invalid(message):
        raise MotionProtocolError('invalid_message', message)

    if value.get('type') != 'motion.welcome':
        invalid('Expected motion.welcome')
    if type(value.get('version')) is not int or value['version'] != 1 or value.get('codec') != CODEC:
        raise MotionProtocolError('unsupported_version', 'Unsupported motion control version or codec')
    for name in ('session_id',):
        if not isinstance(value.get(name), str) or not UUID.fullmatch(value[name]):
            invalid('Invalid UUID')
    if not isinstance(value.get('scene_hash'), str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value['scene_hash']):
        invalid('Invalid scene hash')
    parse_u64(value.get('epoch'))
    revision(value.get('mapping_revision'))
    if (type(value.get('rate_hz')) is not int or value['rate_hz'] not in (15, 30)
            or value.get('coordinate_frame') != 'rh-y-up-m'
            or type(value.get('simulation_rate')) is not int or value['simulation_rate'] != 1):
        invalid('Unsupported motion coordinate frame, rate or simulation rate')
    for name, limit in (('pose_keys', MAX_BODIES), ('joint_keys', MAX_JOINTS)):
        keys = value.get(name)
        if not isinstance(keys, list) or len(keys) > limit:
            raise MotionProtocolError('limit_exceeded', 'Motion dictionary exceeds bounds')
        if any(not isinstance(key, str) or not key or utf8_size(key) > 128 for key in keys):
            invalid('Invalid motion key')
        if len(set(keys)) != len(keys):
            invalid('Motion dictionary keys must be unique')
    targets = value.get('targets')
    if not isinstance(targets, list) or len(targets) != len(value['pose_keys']):
        invalid('Every pose key requires one ordered visual target')
    for key, target in zip(value['pose_keys'], targets):
        if (not isinstance(target, dict) or target.get('pose_key') != key
                or target.get('visual_target') != 'node-root'):
            invalid('Visual target must match ordered pose key and node root')
        for name in ('entity_id', 'node_id'):
            if not isinstance(target.get(name), str) or not UUID.fullmatch(target[name]):
                invalid('Invalid visual target UUID')
        if 'body_to_visual' in target:
            correction = target['body_to_visual']
            if (not isinstance(correction, dict)
                    or not isinstance(correction.get('position'), list)
                    or not isinstance(correction.get('quaternion'), list)):
                invalid('Invalid correction pose')
            validate_pose(correction)
            encode_snapshot({'epoch': 0, 'sequence': 0, 'sim_time_ns': 0,
                             'mapping_revision': 0, 'poses': [correction], 'joints': []})
    if len({target['node_id'] for target in targets}) != len(targets):
        invalid('Multiple poses cannot target the same Scene Node root')
    return value


def session_boundary(value):
    for name in ('session_id', 'transition_id'):
        if not isinstance(value.get(name), str) or not UUID.fullmatch(value[name]):
            raise MotionProtocolError('invalid_message', 'Invalid Session UUID')
    parse_u64(value.get('epoch'))
    if type(value.get('revision')) is not int or not 0 <= value['revision'] <= (1 << 53) - 1:
        raise MotionProtocolError('invalid_message', 'Invalid Session revision')
    if value.get('action') not in ('pause', 'resume', 'stop'):
        raise MotionProtocolError('invalid_message', 'Invalid Session action')
    return {name: value[name] for name in ('session_id', 'epoch', 'transition_id', 'revision', 'action')}


def parse_session_control(text):
    value = control_json(text, MAX_SESSION_CONTROL_BYTES)
    if value.get('type') != 'motion.session_control':
        raise MotionProtocolError('invalid_message', 'Expected motion.session_control')
    return {'type': 'motion.session_control', **session_boundary(value)}


def parse_session_ack(text):
    value = control_json(text, MAX_SESSION_CONTROL_BYTES)
    if value.get('type') != 'motion.session_ack' or value.get('result') != 'applied':
        raise MotionProtocolError('invalid_message', 'Expected applied motion.session_ack')
    parse_u64(value.get('last_sequence'))
    parse_u64(value.get('sim_time_ns'))
    return {'type': 'motion.session_ack', **session_boundary(value), 'result': 'applied',
            'last_sequence': value['last_sequence'], 'sim_time_ns': value['sim_time_ns']}


def json_snapshot(snapshot):
    return {**snapshot, **{key: str(snapshot[key]) for key in ('epoch', 'sequence', 'sim_time_ns')}}


def main():
    """Tiny stdlib cross-language oracle: stdin JSON in, stdout JSON out."""
    request = json.load(sys.stdin)
    try:
        if request['operation'] == 'encode':
            snapshot = request['snapshot']
            for name in ('epoch', 'sequence', 'sim_time_ns'):
                snapshot[name] = parse_u64(snapshot[name])
            result = {'hex': encode_snapshot(snapshot).hex()}
        elif request['operation'] == 'decode':
            expected = request.get('expected')
            if expected and 'epoch' in expected:
                expected['epoch'] = parse_u64(expected['epoch'])
            result = {'snapshot': json_snapshot(decode_snapshot(bytes.fromhex(request['hex']), expected))}
        elif request['operation'] == 'welcome':
            result = {'welcome': parse_welcome(request['text'])}
        elif request['operation'] == 'session_control':
            result = {'control': parse_session_control(request['text'])}
        elif request['operation'] == 'session_ack':
            result = {'ack': parse_session_ack(request['text'])}
        else:
            raise MotionProtocolError('invalid_message', 'Unsupported oracle operation')
        print(json.dumps(result, allow_nan=False, separators=(',', ':')))
    except MotionProtocolError as error:
        print(json.dumps({'error': error.code}))


if __name__ == '__main__':
    main()
