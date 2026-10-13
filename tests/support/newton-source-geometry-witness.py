"""Independent USD vertex oracle; imports no source-export implementation."""
import base64
import json
from pathlib import Path
import sys
import zlib

import numpy as np
from pxr import Gf, Usd, UsdGeom

stage = Usd.Stage.Open(sys.argv[1])
manifest = json.loads(Path(sys.argv[2]).read_text())
cache = UsdGeom.XformCache(Usd.TimeCode.Default())
components = {c['component_key']: c for c in manifest['components']}
result = {}
root = stage.GetPrimAtPath(manifest['source_scene_baseline']['root_path'])
source_meshes = [prim for prim in Usd.PrimRange(root, Usd.TraverseInstanceProxies()) if prim.IsA(UsdGeom.Mesh)]
declared_meshes = {node['source_path']: node for node in manifest['source_hierarchy'] if node['type'] == 'Mesh'}
source_paths = {str(prim.GetPath()) for prim in source_meshes}
if source_paths != declared_meshes.keys():
    raise ValueError(f'Source mesh hierarchy differs: missing={sorted(source_paths-declared_meshes.keys())}, extra={sorted(declared_meshes.keys()-source_paths)}')
classification = {}
for prim in source_meshes:
    path = str(prim.GetPath())
    image = UsdGeom.Imageable(prim)
    purpose, visibility = str(image.ComputePurpose()), str(image.ComputeVisibility())
    drawn = purpose in ('default', 'render') and visibility != 'invisible'
    kind = 'visible' if drawn else 'guide' if purpose == 'guide' else 'hidden'
    classification[kind] = classification.get(kind, 0) + 1
    node = declared_meshes[path]
    if (node['purpose'], node['visibility'], node['drawn']) != (purpose, visibility, drawn):
        raise ValueError(f'Source visibility/purpose differs: {path}')
    if not drawn:
        continue
    owners = [c for c in components.values() if prim.GetPath().HasPrefix(c['source_path'])]
    if not owners:
        raise ValueError(f'Visible source mesh has no component: {path}')
    component = max(owners, key=lambda c: len(c['source_path']))
    if node['component_key'] != component['component_key']:
        raise ValueError(f'Source component ownership differs: {path}')
    source_root = stage.GetPrimAtPath(component['source_path'])
    world = cache.GetLocalToWorldTransform(source_root)
    # Strip only root translation/rotation; retain authored geometry scale and offsets.
    transform = Gf.Transform(world)
    rigid = Gf.Matrix4d(1).SetRotate(transform.GetRotation())
    rigid.SetTranslateOnly(transform.GetTranslation())
    matrix = np.asarray(cache.GetLocalToWorldTransform(prim) * rigid.GetInverse())
    mesh = UsdGeom.Mesh(prim)
    points = np.asarray(mesh.GetPointsAttr().Get(), dtype=np.float64)
    used = np.unique(np.asarray(mesh.GetFaceVertexIndicesAttr().Get(), dtype=np.int64))
    local = np.column_stack((points[used], np.ones(len(used)))) @ matrix
    mapped = local[:, [0, 2, 1]].copy()
    mapped[:, 2] *= -1
    unique = np.unique(np.round(mapped, decimals=8), axis=0)
    packed = unique.astype('<f4').tobytes()
    result[path] = {'component_key': component['component_key'], 'vertices': len(unique),
        'points_f32_zlib_base64': base64.b64encode(zlib.compress(packed)).decode(),
        'bounds': [mapped.min(axis=0).tolist(), mapped.max(axis=0).tolist()],
        'source_face_count': len(mesh.GetFaceVertexCountsAttr().Get())}
Path(sys.argv[3]).write_text(json.dumps({'reader': 'USD authored mesh/transform API; independent from exporter', 'meshes': result,
                                     'source_hierarchy_classification': classification}))
