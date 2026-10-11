"""Validate and recover the one supported physics closure before importing a solver."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import tempfile
import zipfile

ROOT = Path(__file__).parent
MAX_GLB_BYTES = 20 * 1024 * 1024
MAX_JSON_BYTES = 64 * 1024


def sha256(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def supported_profile():
    profile = json.loads((ROOT/'scene/supported-profile.json').read_text())
    preimage = {key:value for key,value in profile.items() if key != 'hash'}
    if sha256(json.dumps(preimage,sort_keys=True,separators=(',',':'),allow_nan=False).encode()) != profile['hash']:
        raise ValueError('Supported profile source changed')
    return profile


def archive_bytes(path, profile):
    expected = profile['visuals'][0]
    if expected['bytes'] > MAX_GLB_BYTES:
        raise ValueError('Unsupported physics container size')
    with Path(path).open('rb') as stream:
        data = stream.read(MAX_GLB_BYTES+1)
    if len(data) != expected['bytes'] or sha256(data) != expected['sha256']:
        raise ValueError('Pinned base GLB changed or archive stripped')
    if len(data)<28 or struct.unpack_from('<III',data) != (0x46546c67,2,len(data)):
        raise ValueError('Invalid physics container')
    size, kind = struct.unpack_from('<II',data,12)
    if kind != 0x4e4f534a or size>MAX_JSON_BYTES or size%4 or 20+size+8>len(data):
        raise ValueError('Invalid bounded GLB JSON')
    model = json.loads(data[20:20+size])
    binary_size,binary_kind = struct.unpack_from('<II',data,20+size)
    if binary_kind != 0x004e4942 or 28+size+binary_size != len(data):
        raise ValueError('Invalid GLB BIN containment')
    locator = model.get('extras',{}).get('lab_word_physics_archive',{})
    expected_archive = profile['physics_archive']
    if set(locator) != {'bufferView','format','sha256','bytes'} or locator['format'] != 'zip' or locator['sha256'] != expected_archive['sha256'] or locator['bytes'] != expected_archive['bytes']:
        raise ValueError('Archive locator mismatch')
    index = locator['bufferView']
    if type(index) is not int or not 0<=index<len(model.get('bufferViews',[])):
        raise ValueError('Invalid archive view')
    view = model['bufferViews'][index]
    offset,length = view.get('byteOffset',0),view.get('byteLength')
    if view.get('buffer') != 0 or type(offset) is not int or type(length) is not int or offset<0 or offset%4 or length != expected_archive['bytes'] or offset+length>binary_size:
        raise ValueError('Archive view outside BIN')
    archive = data[28+size+offset:28+size+offset+length]
    if sha256(archive) != expected_archive['sha256']:
        raise ValueError('Pinned archive digest mismatch')
    return archive


def extract_scene(base_glb, parent, profile=None):
    supported = supported_profile()
    if profile is not None and profile['hash'] != supported['hash']:
        raise ValueError('Unsupported Newton profile')
    archive = archive_bytes(base_glb,supported)
    expected = {entry['path']:entry for entry in supported['physics_archive']['members']}
    output = None
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            members = bundle.infolist()
            if len(members)!=len(expected) or len({member.filename for member in members})!=len(expected) or {member.filename for member in members}!=set(expected):
                raise ValueError('Unexpected or duplicate physics members')
            declared_total = 0
            for member in members:
                name = member.filename
                path = PurePosixPath(name)
                kind = (member.external_attr>>16)&0o170000
                if (path.is_absolute() or '\\' in name or any(part in ('','..','.') for part in path.parts)
                        or member.is_dir() or member.flag_bits&1 or member.compress_type!=zipfile.ZIP_DEFLATED
                        or kind not in (0,stat.S_IFREG) or member.file_size!=expected[name]['bytes']):
                    raise ValueError('Unsafe physics member')
                declared_total += member.file_size
            if declared_total != sum(entry['bytes'] for entry in expected.values()) or declared_total>20*1024*1024:
                raise ValueError('Physics decompressed budget mismatch')
            output = Path(tempfile.mkdtemp(prefix='physics-',dir=parent))
            total = 0
            for member in members:
                target = output / member.filename
                target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                digest = hashlib.sha256(); size = 0
                with bundle.open(member) as source,target.open('xb') as destination:
                    while True:
                        chunk = source.read(min(65536,expected[member.filename]['bytes']-size+1))
                        if not chunk:
                            break
                        size += len(chunk); total += len(chunk)
                        if size>expected[member.filename]['bytes'] or total>declared_total:
                            raise ValueError('Physics decompression exceeded budget')
                        digest.update(chunk); destination.write(chunk)
                if size!=expected[member.filename]['bytes'] or 'sha256:'+digest.hexdigest()!=expected[member.filename]['sha256']:
                    raise ValueError('Pinned physics member changed')
            return output
    except BaseException:
        if output is not None:
            shutil.rmtree(output)
        raise
