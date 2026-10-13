"""Portable manifest boundary; independent of Newton, USD, Blender and Server."""
import hashlib
import json
from pathlib import PurePosixPath
import re
import struct
import math
import uuid


class SourceToolError(Exception):
    def __init__(self, code, path=None, message=None):
        super().__init__(message or code)
        self.code, self.path, self.message = code, path, message or code

    def report(self):
        return {'code': self.code, 'path': self.path, 'message': self.message}


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def resource_path(root, name):
    path = PurePosixPath(name)
    if (path.is_absolute() or str(path) != name or '..' in path.parts or
            not re.fullmatch(r'[A-Za-z0-9_./-]+', name)):
        raise SourceToolError('resource_path_invalid', name)
    target = root.joinpath(*path.parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise SourceToolError('resource_path_invalid', name)
    return target


def validate_manifest(value, root):
    if not isinstance(value, dict):
        raise SourceToolError('manifest_collection_invalid', 'manifest')
    for name in ('objects', 'components', 'resources', 'bodies', 'joints', 'source_hierarchy'):
        entries = value.get(name, [])
        if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
            raise SourceToolError('manifest_collection_invalid', name)
    seen = set()
    for item in value.get('objects', []):
        key = item.get('object_key')
        if key in seen:
            raise SourceToolError('duplicate_object_key', key)
        seen.add(key)
        reference = item.get('asset_ref')
        if reference is not None and (not isinstance(reference, dict) or
                                      not reference.get('asset_id') or not reference.get('version')):
            raise SourceToolError('asset_reference_invalid', key)
    for item in value.get('resources', []):
        target = resource_path(root, item['path'])
        data = target.read_bytes()
        if item.get('sha256') != digest(data):
            raise SourceToolError('resource_digest_mismatch', item['path'])
        if item.get('bytes') != len(data) or not 0 < len(data) <= 20 * 1024 * 1024:
            raise SourceToolError('resource_size_invalid', item['path'])
        if item.get('content_type') == 'model/gltf-binary':
            validate_glb(data, item['path'])
    if value.get('schema_version') != 1:
        raise SourceToolError('schema_version_unsupported')
    try:
        uuid.UUID(value['source_id'])
    except (ValueError, KeyError, TypeError) as error:
        raise SourceToolError('source_id_invalid') from error
    if value.get('coordinate_frame') != 'rh-y-up-m' or value.get('source_coordinate_frame') != 'rh-z-up-m':
        raise SourceToolError('coordinate_frame_invalid')
    tables = {}
    for name, key in [('objects', 'object_key'), ('components', 'component_key'), ('resources', 'resource_key'),
                      ('bodies', 'body_key'), ('joints', 'joint_key'), ('source_hierarchy', 'source_path')]:
        entries = value.get(name)
        if not isinstance(entries, list):
            raise SourceToolError('manifest_collection_invalid', name)
        table = {}
        for item in entries:
            identity = item.get(key)
            if not isinstance(identity, str) or not identity or len(identity) > 1024 or identity in table:
                raise SourceToolError('manifest_identity_invalid', name)
            table[identity] = item
        tables[name] = table
    for component in value['components']:
        if component['object_key'] not in tables['objects'] or component['resource_key'] not in tables['resources']:
            raise SourceToolError('component_reference_missing', component['component_key'])
        if component.get('origin') != 'body-local':
            raise SourceToolError('component_origin_invalid', component['component_key'])
    for obj in value['objects']:
        if any(key not in tables['components'] for key in obj['component_keys']):
            raise SourceToolError('object_component_missing', obj['object_key'])
    for body in value['bodies']:
        if body['component_key'] not in tables['components']:
            raise SourceToolError('body_component_missing', body['body_key'])
    for joint in value['joints']:
        for key in ('parent_body_key', 'child_body_key'):
            if joint.get(key) is not None and joint[key] not in tables['bodies']:
                raise SourceToolError('joint_body_missing', joint['joint_key'])
        if joint.get('motion_supported') and (joint.get('type') not in ('revolute', 'prismatic') or
                                               joint.get('unit') not in ('rad', 'm') or not joint.get('coordinate_key')):
            raise SourceToolError('joint_coordinate_invalid', joint['joint_key'])
    initial = value.get('initial_state')
    if not isinstance(initial, dict):
        raise SourceToolError('initial_state_missing')
    expected = {c['pose_key'] for c in value['components']}
    actual = set()
    for pose in initial.get('poses', []):
        p, q = pose.get('position', []), pose.get('quaternion', [])
        if (pose.get('pose_key') in actual or len(p) != 3 or len(q) != 4 or
                any(type(x) not in (int, float) or not math.isfinite(x) for x in p+q) or
                abs(sum(x*x for x in q)-1) > 0.001):
            raise SourceToolError('initial_pose_invalid', pose.get('pose_key'))
        actual.add(pose['pose_key'])
    if actual != expected:
        raise SourceToolError('initial_pose_dictionary_mismatch')
    content = {k: v for k, v in value.items() if k not in ('initial_state', 'source_id', 'provenance', 'scene_hash')}
    if value.get('scene_hash') != digest(canonical(content)):
        raise SourceToolError('scene_digest_mismatch')
    return value


def validate_glb(data, path):
    if len(data) < 28 or struct.unpack_from('<III', data) != (0x46546c67, 2, len(data)):
        raise SourceToolError('glb_invalid', path)
    size, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4e4f534a or size % 4 or size + 28 > len(data):
        raise SourceToolError('glb_invalid', path)
    document = json.loads(data[20:20+size])
    for collection in ('buffers', 'images'):
        for entry in document.get(collection, []):
            uri = entry.get('uri')
            if uri and not uri.startswith('data:'):
                raise SourceToolError('glb_external_resource', path)
    if not document.get('meshes'):
        raise SourceToolError('glb_geometry_missing', path)
