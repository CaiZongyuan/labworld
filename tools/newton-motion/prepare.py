"""Materialize the pinned SO-101 package through the production archive loader.

The exact maker and derived collision closure travels inside base.glb. Preparing
this package needs no network, mesh generation, solver or third-party imports.
"""
import argparse
import json
from pathlib import Path
import shutil

from scene_loader import archive_bytes, extract_scene, sha256, supported_profile

ROOT = Path(__file__).parent


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def prepare(output):
    profile = supported_profile()
    source = ROOT / 'scene/representations'
    expected_names = {visual['file'] for visual in profile['visuals']}
    if {path.name for path in source.iterdir()} != expected_names:
        raise ValueError('Bundled Newton representations do not match the fixed profile')
    for visual in profile['visuals']:
        path = source / visual['file']
        if path.is_symlink() or not path.is_file():
            raise ValueError('Unsupported bundled Newton representation')
        data = path.read_bytes()
        if len(data) != visual['bytes'] or sha256(data) != visual['sha256']:
            raise ValueError('Bundled Newton representation changed: ' + visual['file'])
    base = source / profile['visuals'][0]['file']
    archive = archive_bytes(base, profile)
    # Never overwrite a user directory or replace failed/partial inputs.
    output.mkdir(parents=True, exist_ok=False)
    extracted = None
    try:
        extracted = extract_scene(base, output, profile)
        for member in profile['physics_archive']['members']:
            destination = output / member['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(extracted / member['path'], destination)
        for visual in profile['visuals']:
            shutil.copyfile(source / visual['file'], output / visual['file'])
        (output / 'physics.zip').write_bytes(archive)
        (output / 'profile.json').write_bytes(canonical(profile) + b'\n')
    finally:
        if extracted is not None:
            shutil.rmtree(extracted)
    return profile


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    profile = prepare(args.output.resolve())
    print(json.dumps({'profile': profile['hash'], 'visuals': len(profile['visuals']), 'output': str(args.output)}))
