"""Strict standard-library LWR1 source codec, independent of live delivery."""

import hashlib
import json
import re
import struct
import uuid

from motion_codec import MotionProtocolError, decode_snapshot, parse_u64, u64

CODEC = 'lwr1-source-v1'
HEADER = struct.Struct('<4sBBH16s16sQQII32s')
PACKET_BYTES = 65536
IDENTITY_FIELDS = ('recording_id', 'session_id', 'lease_id', 'epoch', 'snapshot_hash',
                   'manifest_sha256', 'scene_hash', 'mapping_revision', 'mapping_sha256')
CAPTURE_POLICY = {'selection': 'all-selected', 'sample_hz': 30, 'motion_codec': 'pose-f32-v1',
                  'first_source_sequence': '1', 'first_source_event_sequence': '1'}


def invalid(code='invalid_message', message='Invalid Recording contract'):
    raise MotionProtocolError(code, message)


def fields(value, names):
    if type(value) is not dict or set(value) != set(names):
        invalid()
    return value


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def control(text, bound):
    if not isinstance(text, str) or len(text.encode('utf-8')) > bound:
        invalid()
    try:
        # Duplicate fields are ambiguous even when the JSON decoder normally accepts them.
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    invalid()
                value[key] = item
            return value
        return json.loads(text, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        invalid()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value):
        invalid('scope_mismatch')
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        invalid()
    return value


def integer(value, maximum=0xffffffff):
    if type(value) is not int or not 0 <= value <= maximum:
        invalid()
    return value


def limits(ack_ms=3000, grace_ms=5000):
    integer(ack_ms); integer(grace_ms)
    if ack_ms < 1000 or grace_ms < 1000:
        invalid()
    deadline = min(1000, ack_ms // 3)
    return {'source_frames': 120, 'source_events': 32, 'source_bytes': 4 * 1024 * 1024,
            'packet_bytes': PACKET_BYTES, 'frame_batch_frames': 32, 'event_bytes': 16384,
            'end_bytes': 4096, 'hello_bytes': 16384, 'ack_bytes': 4096,
            'server_records': 256, 'server_bytes': 8 * 1024 * 1024,
            'durability_timeout_ms': deadline, 'retry_attempts': 2,
            'retry_first_ms': deadline // 3, 'retry_second_ms': 2 * deadline // 3,
            'sync_flush_ms': min(100, deadline // 4), 'segment_bytes': 1024 * 1024,
            'segment_ms': 5000, 'lifecycle_ack_timeout_ms': ack_ms, 'heartbeat_grace_ms': grace_ms}


def parse_limits(value):
    fields(value, limits())
    for number in value.values():
        integer(number)
    if value != limits(value['lifecycle_ack_timeout_ms'], value['heartbeat_grace_ms']):
        invalid()
    return dict(value)


def policy(value):
    fields(value, CAPTURE_POLICY)
    if value != CAPTURE_POLICY or type(value['sample_hz']) is not int:
        invalid()
    return dict(CAPTURE_POLICY)


def source_header(value):
    fields(value, ('source_kind', 'implementation', 'python_version', 'dependencies', 'capture_policy'))
    if value['source_kind'] not in ('synthetic', 'newton'):
        invalid()

    def text(value):
        if not isinstance(value, str) or not re.fullmatch(r'[\x20-\x21\x23-\x5b\x5d-\x7e]{1,128}', value):
            invalid()
        return value

    def implementation(value):
        fields(value, ('name', 'version', 'sha256'))
        return {'name': text(value['name']), 'version': None if value['version'] is None else text(value['version']),
                'sha256': None if value['sha256'] is None else digest(value['sha256'])}

    dependencies = value['dependencies']
    if type(dependencies) is not list or len(dependencies) > 32:
        invalid()
    dependencies = [implementation(entry) for entry in dependencies]
    names = [entry['name'] for entry in dependencies]
    if names != sorted(set(names)):
        invalid()
    return {'source_kind': value['source_kind'], 'implementation': implementation(value['implementation']),
            'python_version': None if value['python_version'] is None else text(value['python_version']),
            'dependencies': dependencies, 'capture_policy': policy(value['capture_policy'])}


def canonical_source_header(value):
    return canonical(source_header(value))


def sha256(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def identity(value):
    for name in ('recording_id', 'session_id', 'lease_id'):
        identifier(value[name])
    parse_u64(value['epoch']); integer(value['mapping_revision'])
    for name in ('snapshot_hash', 'manifest_sha256', 'scene_hash', 'mapping_sha256'):
        digest(value[name])
    return {name: value[name] for name in IDENTITY_FIELDS}


def parse_bootstrap(value):
    fields(value, (*IDENTITY_FIELDS, 'websocket_path', 'ticket', 'expires_in_seconds', 'capture_policy', 'limits'))
    identity(value)
    if (value['websocket_path'] != f"/api/v1/lab/recordings/{value['recording_id']}/source"
            or type(value['expires_in_seconds']) is not int or value['expires_in_seconds'] != 30
            or not isinstance(value['ticket'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,512}', value['ticket'])):
        invalid('scope_mismatch')
    return {**identity(value), 'websocket_path': value['websocket_path'], 'ticket': value['ticket'],
            'expires_in_seconds': 30, 'capture_policy': policy(value['capture_policy']), 'limits': parse_limits(value['limits'])}


def parse_ready(text):
    value = fields(control(text, 16384), ('type', 'version', 'codec', *IDENTITY_FIELDS,
                                        'source_header_sha256', 'source_prefix_sha256', 'capture_policy', 'limits'))
    if value['type'] != 'recording.ready' or type(value['version']) is not int or value['version'] != 1 or value['codec'] != CODEC:
        invalid()
    identity(value); digest(value['source_header_sha256']); digest(value['source_prefix_sha256'])
    policy(value['capture_policy']); parse_limits(value['limits'])
    return value


def verify_ready(text, bootstrap, header, welcome):
    value = parse_ready(text)
    if (any(value[name] != bootstrap[name] for name in IDENTITY_FIELDS)
            or value['session_id'] != welcome['session_id'] or value['epoch'] != welcome['epoch']
            or value['scene_hash'] != welcome['scene_hash'] or value['mapping_revision'] != welcome['mapping_revision']
            or value['mapping_sha256'] != mapping_digest(welcome['mapping_revision'], welcome['pose_keys'], welcome['joint_keys'])
            or value['source_header_sha256'] != sha256(canonical_source_header(header))
            or value['source_prefix_sha256'] != source_prefix_seed(bootstrap, value['source_header_sha256'])
            or value['capture_policy'] != bootstrap['capture_policy'] or value['limits'] != bootstrap['limits']):
        invalid('scope_mismatch', 'Recording READY does not match source admission')
    return value


def parse_ack(text):
    value = fields(control(text, 4096), ('type', 'version', 'recording_id', 'session_id', 'lease_id', 'epoch',
                                        'source_packet_sequence', 'packet_sha256', 'source_prefix_sha256',
                                        'durable_source_sequence', 'durable_source_event_sequence', 'source_ended'))
    if value['type'] != 'recording.ack' or type(value['version']) is not int or value['version'] != 1:
        invalid('invalid_ack')
    for name in ('recording_id', 'session_id', 'lease_id'):
        identifier(value[name])
    for name in ('epoch', 'source_packet_sequence', 'durable_source_sequence', 'durable_source_event_sequence'):
        parse_u64(value[name])
    digest(value['packet_sha256']); digest(value['source_prefix_sha256'])
    if type(value['source_ended']) is not bool:
        invalid('invalid_ack')
    return value


def mapping_digest(revision, pose_keys, joint_keys):
    integer(revision)
    parts = [b'LWR1-MAPPING\0', struct.pack('<III', revision, len(pose_keys), len(joint_keys))]
    for keys in (pose_keys, joint_keys):
        if len(keys) > 1024 or len(keys) != len(set(keys)):
            invalid('mapping_mismatch')
        for key in keys:
            if not isinstance(key, str) or not key or len(key.encode('utf-8')) > 128:
                invalid('mapping_mismatch')
            encoded = key.encode('utf-8')
            parts.extend((struct.pack('<I', len(encoded)), encoded))
    return sha256(b''.join(parts))


def source_prefix_seed(scope, header_digest):
    return sha256(b'LWR1-SOURCE\0' + b''.join(uuid.UUID(identifier(scope[name])).bytes for name in
                  ('recording_id', 'session_id', 'lease_id')) + struct.pack('<Q', parse_u64(scope['epoch']))
                  + b''.join(bytes.fromhex(digest(value)[7:]) for value in
                             (scope['manifest_sha256'], scope['snapshot_hash'], scope['mapping_sha256'], header_digest)))


def advance_prefix(previous, packet_digest):
    return sha256(bytes.fromhex(digest(previous)[7:]) + bytes.fromhex(digest(packet_digest)[7:]))


def encode_packet(scope, sequence, kind, payload):
    if kind not in (1, 2, 3) or len(payload) + HEADER.size > PACKET_BYTES or u64(sequence) == 0:
        invalid('source_capacity')
    if (kind == 2 and len(payload) > 16384) or (kind == 3 and len(payload) > 4096):
        invalid('source_capacity')
    header = HEADER.pack(b'LWR1', 1, kind, 0, uuid.UUID(identifier(scope['recording_id'])).bytes,
                         uuid.UUID(identifier(scope['session_id'])).bytes, parse_u64(scope['epoch']), sequence,
                         len(payload), 0, bytes(32))
    packet_digest = hashlib.sha256(header[:64] + payload).digest()
    return header[:64] + packet_digest + payload


def decode_packet(data, scope=None):
    if not HEADER.size <= len(data) <= PACKET_BYTES:
        invalid('invalid_packet')
    magic, version, kind, flags, recording_id, session_id, epoch, sequence, size, reserved, packet_digest = HEADER.unpack_from(data)
    if (magic != b'LWR1' or version != 1 or kind not in (1, 2, 3) or flags or reserved
            or sequence == 0 or size != len(data) - HEADER.size):
        invalid('invalid_packet')
    if (kind == 2 and size > 16384) or (kind == 3 and size > 4096):
        invalid('invalid_packet')
    if scope is not None and (str(uuid.UUID(bytes=recording_id)) != scope['recording_id']
                              or str(uuid.UUID(bytes=session_id)) != scope['session_id'] or epoch != parse_u64(scope['epoch'])):
        invalid('scope_mismatch')
    if hashlib.sha256(data[:64] + data[HEADER.size:]).digest() != packet_digest:
        invalid('altered_duplicate')
    return {'kind': kind, 'source_packet_sequence': sequence, 'packet_sha256': 'sha256:' + packet_digest.hex(),
            'payload': memoryview(data)[HEADER.size:]}


def encode_frame_batch(frames):
    if not 1 <= len(frames) <= 32:
        invalid('source_capacity')
    first = decode_snapshot(frames[0]); frame_bytes = len(frames[0]); timestamp = first['sim_time_ns']
    if first['sequence'] == 0:
        invalid('sequence_gap')
    expected = {'epoch': first['epoch'], 'mapping_revision': first['mapping_revision'],
                'body_count': len(first['poses']), 'joint_count': len(first['joints'])}
    for index, frame in enumerate(frames):
        snapshot = decode_snapshot(frame, expected)
        if len(frame) != frame_bytes or snapshot['sequence'] != first['sequence'] + index or snapshot['sim_time_ns'] < timestamp:
            invalid('sequence_gap')
        timestamp = snapshot['sim_time_ns']
    if 16 + frame_bytes * len(frames) + HEADER.size > PACKET_BYTES:
        invalid('source_capacity')
    return struct.pack('<QII', first['sequence'], len(frames), frame_bytes) + b''.join(frames)


def parse_source_event(text):
    value = fields(control(text, 16384), ('source_event_sequence', 'event_id', 'event_type', 'subject', 'sim_time_ns', 'observed_at', 'event'))
    if parse_u64(value['source_event_sequence']) == 0:
        invalid('sequence_gap')
    parse_u64(value['sim_time_ns']); identifier(value['event_id'])
    if value['event_type'] != 'lifecycle.applied':
        invalid('invalid_packet', 'Source event authority is lifecycle-only')
    identifier(fields(value['subject'], ('session_id',))['session_id'])
    event = fields(value['event'], ('transition_id', 'revision', 'action', 'boundary_source_sequence'))
    identifier(event['transition_id']); integer(event['revision'], (1 << 53) - 1); parse_u64(event['boundary_source_sequence'])
    if event['action'] not in ('pause', 'resume', 'stop'):
        invalid('invalid_packet')
    if value['observed_at'] is not None:
        from datetime import datetime
        if not isinstance(value['observed_at'], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value['observed_at']):
            invalid('invalid_packet')
        try:
            datetime.fromisoformat(value['observed_at'].replace('Z', '+00:00'))
        except ValueError:
            invalid('invalid_packet')
    return value


def parse_source_end(text):
    value = fields(control(text, 4096), ('transition_id', 'revision', 'reason', 'last_source_sequence', 'last_source_event_sequence', 'sim_time_ns'))
    identifier(value['transition_id']); integer(value['revision'], (1 << 53) - 1)
    for name in ('last_source_sequence', 'last_source_event_sequence', 'sim_time_ns'):
        parse_u64(value[name])
    if value['reason'] != 'stop':
        invalid('invalid_packet')
    return value
