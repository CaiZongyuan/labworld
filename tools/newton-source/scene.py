"""USD source description and component export, with authored layout kept separate."""
import json
from pathlib import Path
import subprocess
import sys

from format import SCENE_HASH_ALGORITHM, SourceToolError, canonical, digest, resource_path, scene_digest


def pose(matrix):
    from pxr import Gf
    transform = Gf.Transform(matrix)
    rotation = transform.GetRotation().GetQuat().GetNormalized()
    x, y, z = rotation.GetImaginary()
    # Conjugation by the fixed -90 degree X basis rotation.
    return {'position': [float(matrix[3][0]), float(matrix[3][2]), -float(matrix[3][1])],
            'quaternion': [float(x), float(z), -float(y), float(rotation.GetReal())]}


def native_pose(value):
    x, y, z, qx, qy, qz, qw = value
    return {'position': [x, z, -y], 'quaternion': [qx, qz, -qy, qw]}


def describe(stage, metadata=None, native_model=None):
    from pxr import Gf, Usd, UsdGeom, UsdPhysics
    metadata = metadata or {}
    if not isinstance(metadata, dict):
        raise SourceToolError('metadata_invalid')
    root_path = metadata.get('root_path', '/World/envs/env_0')
    root = stage.GetPrimAtPath(root_path)
    if not root:
        raise SourceToolError('scene_root_missing', root_path)
    if str(UsdGeom.GetStageUpAxis(stage)) != 'Z' or UsdGeom.GetStageMetersPerUnit(stage) != 1.0:
        raise SourceToolError('coordinate_frame_unsupported', root_path, 'This adapter requires source Z-up and metres.')
    cache = UsdGeom.XformCache(Usd.TimeCode.Default())
    declarations = {x['source_path']: x for x in metadata.get('objects', [])}
    candidates = {str(p.GetPath()): p for p in root.GetChildren()}
    for path in declarations:
        candidates[path] = stage.GetPrimAtPath(path)
    objects, components, hierarchy, bodies = [], [], [], []
    for path, prim in sorted(candidates.items()):
        if not prim:
            raise SourceToolError('object_path_missing', path)
        prims = list(Usd.PrimRange(prim, Usd.TraverseInstanceProxies()))
        geometry = [p for p in prims if p.IsA(UsdGeom.Gprim)]
        if not geometry:
            continue
        declaration = declarations.get(path, {})
        key = declaration.get('object_key', prim.GetName())
        asset_ref = declaration.get('asset_ref')
        if asset_ref is not None and (not isinstance(asset_ref, dict) or
                                     not asset_ref.get('asset_id') or not asset_ref.get('version')):
            raise SourceToolError('asset_reference_invalid', path)
        body_roots = [p for p in prims if p.HasAPI(UsdPhysics.RigidBodyAPI)]
        roots = body_roots or [prim]
        component_keys = []
        for component_root in roots:
            visible = [p for p in geometry if p.GetPath().HasPrefix(component_root.GetPath()) and
                       str(UsdGeom.Imageable(p).ComputePurpose()) in ('default', 'render') and
                       str(UsdGeom.Imageable(p).ComputeVisibility()) != 'invisible']
            if not visible:
                continue
            source_path = str(component_root.GetPath())
            suffix = source_path[len(path):].strip('/') or 'root'
            component_key = key + '/' + suffix
            component_keys.append(component_key)
            component = {'component_key': component_key, 'asset_component_key': suffix,
                         'object_key': key, 'source_path': source_path, 'parent_component_key': None,
                         'pose_key': 'pose:' + component_key, 'body_key': None,
                         'resource_key': 'web:' + component_key, 'origin': 'body-local'}
            if component_root.HasAPI(UsdPhysics.RigidBodyAPI):
                component['body_key'] = 'body:' + component_key
                bodies.append({'body_key': component['body_key'], 'source_path': source_path,
                               'object_key': key, 'component_key': component_key, 'pose_key': component['pose_key'],
                               'kinematic': bool(UsdPhysics.RigidBodyAPI(component_root).GetKinematicEnabledAttr().Get())})
            component['authored_pose'] = pose(cache.GetLocalToWorldTransform(component_root))
            components.append(component)
        objects.append({'object_key': key, 'source_path': path, 'parent_object_key': None,
                        'asset_ref': asset_ref, 'asset_description': declaration.get('asset_description'),
                        'representation_key': declaration.get('representation_key', 'web'), 'component_keys': component_keys})
        for p in prims:
            if not p.IsA(UsdGeom.Imageable) and p.GetTypeName() != 'Scope':
                continue
            image = UsdGeom.Imageable(p)
            purpose = str(image.ComputePurpose()) if image else 'default'
            visibility = str(image.ComputeVisibility()) if image else 'inherited'
            owner = next((c for c in sorted(components, key=lambda c: len(c['source_path']), reverse=True)
                          if str(p.GetPath()) == c['source_path'] or str(p.GetPath()).startswith(c['source_path'] + '/')), None)
            local = UsdGeom.Xformable(p).GetLocalTransformation() if p.IsA(UsdGeom.Xformable) else Gf.Matrix4d(1)
            physics = {a.GetName(): str(a.Get()) for a in p.GetAttributes()
                       if a.GetName().startswith(('physics:', 'newton:', 'physx', 'drive:', 'state:'))}
            hierarchy.append({'source_path': str(p.GetPath()), 'parent_source_path': str(p.GetParent().GetPath()),
                              'type': str(p.GetTypeName()), 'purpose': purpose, 'visibility': visibility,
                              'drawn': p.IsA(UsdGeom.Gprim) and purpose in ('default', 'render') and visibility != 'invisible',
                              'component_key': owner['component_key'] if owner else None,
                              'local_matrix': [float(v) for row in local for v in row], 'physics': physics})
    if not components:
        raise SourceToolError('scene_geometry_missing', root_path)
    body_by_path = {x['source_path']: x['body_key'] for x in bodies}
    joints = native_model.get('joints', []) if native_model else []
    if not native_model:
        for p in stage.Traverse(Usd.TraverseInstanceProxies()):
            if p.IsA(UsdPhysics.Joint):
                path = str(p.GetPath())
                joint_type = 'revolute' if p.IsA(UsdPhysics.RevoluteJoint) else 'prismatic' if p.IsA(UsdPhysics.PrismaticJoint) else 'fixed' if p.IsA(UsdPhysics.FixedJoint) else 'unsupported'
                key = 'joint:' + path.removeprefix(root_path + '/').replace('/joints/', '/')
                api = UsdPhysics.Joint(p)
                parents, children = api.GetBody0Rel().GetTargets(), api.GetBody1Rel().GetTargets()
                joints.append({'joint_key': key, 'source_path': path, 'source_path_kind': 'usd-prim', 'type': joint_type,
                               'parent_body_key': body_by_path.get(str(parents[0])) if parents else None,
                               'child_body_key': body_by_path.get(str(children[0])) if children else None,
                               'motion_supported': joint_type in ('revolute', 'prismatic'),
                               'coordinate_key': key + '/position' if joint_type in ('revolute', 'prismatic') else None,
                               'unit': 'rad' if joint_type == 'revolute' else 'm' if joint_type == 'prismatic' else None})
    return {'objects': objects, 'components': components, 'bodies': bodies, 'joints': joints,
            'source_hierarchy': sorted(hierarchy, key=lambda x: x['source_path']),
            'source_scene_baseline': {'root_path': root_path, 'transform_origin': 'authored-default-before-program-steps'}}


def windows_path(path, blender):
    if sys.platform == 'linux' and str(blender).lower().endswith('.exe'):
        return subprocess.check_output(['wslpath', '-w', str(Path(path).resolve())], text=True).strip()
    return str(Path(path).resolve())


def export_scene(args):
    from pxr import Sdf, Usd, UsdGeom, UsdShade
    from ownership import OwnedRun
    source = args.scene.resolve()
    try:
        stage = Usd.Stage.Open(str(source))
    except Exception as error:
        raise SourceToolError('scene_unreadable', str(source), str(error)) from error
    if not stage:
        raise SourceToolError('scene_unreadable', str(source))
    metadata = json.loads(args.metadata.read_text()) if args.metadata else {}
    snapshot = json.loads(args.snapshot.read_text()) if args.snapshot else None
    if args.snapshot and (not isinstance(snapshot, dict) or not isinstance(snapshot.get('state'), dict)):
        raise SourceToolError('initial_state_missing', str(args.snapshot))
    native_model = snapshot.get('native_model') if snapshot else None
    if native_model is not None and not isinstance(native_model, dict):
        raise SourceToolError('native_model_invalid', str(args.snapshot))
    descriptor = describe(stage, metadata, native_model)
    with OwnedRun(args.output, 'export') as owner:
        copied = Usd.Stage.Open(stage.Flatten())
        while True:
            instances = [p for p in copied.Traverse() if p.IsInstance()]
            if not instances:
                break
            for p in instances:
                p.SetInstanceable(False)
        for node in descriptor['source_hierarchy']:
            p = copied.GetPrimAtPath(node['source_path'])
            p.CreateAttribute('userProperties:labworld_source_path', Sdf.ValueTypeNames.String, custom=True).Set(node['source_path'])
        for component in descriptor['components']:
            p = copied.GetPrimAtPath(component['source_path'])
            p.CreateAttribute('userProperties:labworld_component_key', Sdf.ValueTypeNames.String, custom=True).Set(component['component_key'])
        for p in list(copied.Traverse()):
            if p.IsA(UsdShade.Material):
                material = UsdShade.Material(p)
                shader = UsdShade.Shader.Define(copied, p.GetPath().AppendChild('LabWorldPreviewSurface'))
                shader.CreateIdAttr('UsdPreviewSurface')
                original = next((c for c in p.GetChildren() if c.IsA(UsdShade.Shader) and c != shader.GetPrim()), None)
                for output_name, sources, fallback, dtype in [
                    ('diffuseColor', ['diffuse_color_constant', 'diffuse_tint', 'diffuseColor'], (0.7, 0.7, 0.7), Sdf.ValueTypeNames.Color3f),
                    ('roughness', ['reflection_roughness_constant', 'roughness'], 0.4, Sdf.ValueTypeNames.Float),
                    ('metallic', ['metallic_constant', 'metallic'], 0.0, Sdf.ValueTypeNames.Float)]:
                    value = next((original.GetAttribute('inputs:' + name).Get() for name in sources
                                  if original and original.GetAttribute('inputs:' + name) and original.GetAttribute('inputs:' + name).Get() is not None), fallback)
                    shader.CreateInput(output_name, dtype).Set(value)
                shader.CreateOutput('surface', Sdf.ValueTypeNames.Token)
                material.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), 'surface')
        prepared = owner.directory / 'prepared.usdc'
        copied.GetRootLayer().Export(str(prepared))
        job = {'scene': windows_path(prepared, args.blender), 'output': windows_path(owner.directory, args.blender),
               'components': descriptor['components'], 'run_id': owner.run_id}
        job_file = owner.directory / 'blender-job.json'
        job_file.write_text(json.dumps(job, indent=2) + '\n')
        worker = Path(__file__).with_name('blender_export.py')
        owner.run([args.blender, '--background', '--factory-startup', '--python', windows_path(worker, args.blender),
                   '--', windows_path(job_file, args.blender)], 'blender', timeout=180)
        result = json.loads((owner.directory / 'blender-result.json').read_text())
        if result.get('error'):
            raise SourceToolError('component_conversion_failed', result['error'].get('source_path'), result['error']['message'])
        resources = []
        for component in descriptor['components']:
            exported = result['components'][component['component_key']]
            component.update(bounds=exported['bounds'], body_to_visual=exported['body_to_visual'])
            resource = owner.directory / exported['path']
            resources.append({'resource_key': component['resource_key'], 'path': exported['path'],
                              'content_type': 'model/gltf-binary', 'sha256': digest(resource.read_bytes()), 'bytes': resource.stat().st_size})
        for obj in descriptor['objects']:
            description = obj.get('asset_description')
            if description is None:
                continue
            if not args.metadata:
                raise SourceToolError('asset_description_invalid', obj['source_path'])
            name = description if isinstance(description, str) else description.get('path') if isinstance(description, dict) else None
            if not isinstance(name, str):
                raise SourceToolError('asset_description_invalid', obj['source_path'])
            source_file = resource_path(args.metadata.resolve().parent, name)
            data = source_file.read_bytes()
            definition = json.loads(data)
            reference = {'asset_id': definition['asset_id'], 'version': definition['version']}
            if obj['asset_ref'] and obj['asset_ref'] != reference:
                raise SourceToolError('asset_description_reference_mismatch', obj['source_path'])
            obj['asset_ref'] = reference
            directory_name = 'assets/' + digest(obj['object_key'].encode())[7:31]
            directory = owner.directory / directory_name
            directory.mkdir(parents=True)
            path = directory_name + '/description.json'
            (owner.directory / path).write_bytes(data)
            obj['asset_description'] = {'path': path, 'sha256': digest(data), 'bytes': len(data)}
            resources.append({'resource_key': 'asset-description:' + obj['object_key'], 'path': path,
                              'content_type': 'application/json', 'sha256': digest(data), 'bytes': len(data)})
            for entry in definition.get('resources', []):
                original = resource_path(source_file.parent, entry['path'])
                copied_resource = resource_path(directory, entry['path'])
                if copied_resource.name == 'description.json':
                    raise SourceToolError('asset_resource_collision', entry['path'])
                resource_data = original.read_bytes()
                if entry.get('sha256') and entry['sha256'] != digest(resource_data):
                    raise SourceToolError('asset_resource_mismatch', entry['path'])
                copied_resource.parent.mkdir(parents=True, exist_ok=True)
                copied_resource.write_bytes(resource_data)
                resources.append({'resource_key': 'asset:' + obj['object_key'] + ':' + entry['path'],
                                  'path': directory_name + '/' + entry['path'], 'sha256': digest(resource_data),
                                  'bytes': len(resource_data), 'content_type': entry['content_type']})
        initial = snapshot['state'] if snapshot else {'source_run_id': None, 'episode_id': None, 'source_sequence': None,
                                                     'source_sim_time_ns': None, 'poses': [], 'joints': []}
        initial = dict(initial)
        positions = {x['pose_key']: x for x in initial['poses']}
        for component in descriptor['components']:
            if component['pose_key'] not in positions:
                positions[component['pose_key']] = {'pose_key': component['pose_key'], **component['authored_pose']}
            del component['authored_pose']
        initial['poses'] = list(positions.values())
        manifest = {'schema_version': 1, 'scene_hash_algorithm': SCENE_HASH_ALGORITHM,
                    'source_id': args.source_id, 'coordinate_frame': 'rh-y-up-m',
                    'source_coordinate_frame': 'rh-z-up-m', **descriptor, 'resources': resources, 'initial_state': initial,
                    'provenance': {'source_kind': 'newton', 'material_policy': 'usd-preview-or-constant-pbr',
                                   'light_policy': 'web-approximation', 'blender_version': result['blender_version']}}
        manifest['scene_hash'] = scene_digest(manifest)
        from format import validate_manifest
        validate_manifest(manifest, owner.directory)
        target = owner.directory / 'scene.json'
        target.write_bytes(canonical(manifest) + b'\n')
        owner.complete(manifest=str(target), scene_hash=manifest['scene_hash'])
        return {'manifest': str(target), 'scene_hash': manifest['scene_hash'], 'objects': len(manifest['objects']),
                'components': len(manifest['components']), 'resource_bytes': sum(r['bytes'] for r in resources)}
