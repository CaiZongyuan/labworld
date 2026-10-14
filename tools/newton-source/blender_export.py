"""Owned Blender conversion worker. It never opens or saves the author's project."""
import json
from pathlib import Path
import os
import sys

import bpy
from mathutils import Matrix, Vector


def main(job):
    output = Path(job['output'])
    receipt = {'pid': os.getpid(), 'run_id': job['run_id']}
    (output / 'blender-process.json').write_text(json.dumps(receipt))
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.wm.usd_import(filepath=job['scene'], set_frame_range=False, import_cameras=False, import_lights=False,
                          import_visible_only=True, import_guide=False, import_proxy=False, import_render=True,
                          import_shapes=True, import_subdivision=False, support_scene_instancing=False,
                          property_import_mode='ALL', merge_parent_xform=False)
    result = {'blender_version': bpy.app.version_string, 'components': {}}
    (output / 'resources').mkdir(exist_ok=True)
    current = None
    try:
        for component in job['components']:
            current = component
            root = next((o for o in bpy.context.scene.objects
                         if o.get('labworld_component_key') == component['component_key']), None)
            if root is None:
                raise ValueError('No imported component root for the original source path')
            selected = []
            def visit(obj):
                selected.append(obj)
                for child in obj.children:
                    if child.get('labworld_component_key') and child != root:
                        continue
                    visit(child)
            visit(root)
            parent, original = root.parent, root.matrix_world.copy()
            translation, rotation, _ = original.decompose()
            rigid = Matrix.LocRotScale(translation, rotation, Vector((1, 1, 1)))
            root.parent = None
            root.matrix_world = rigid.inverted() @ original
            bpy.context.view_layer.update()
            bpy.ops.object.select_all(action='DESELECT')
            points = []
            for obj in selected:
                obj.select_set(True)
                if obj.type == 'MESH':
                    for corner in obj.bound_box:
                        p = obj.matrix_world @ Vector(corner)
                        points.append((p.x, p.z, -p.y))
            if not points:
                raise ValueError('Component has no visible geometry')
            minimum = [min(p[i] for p in points) for i in range(3)]
            maximum = [max(p[i] for p in points) for i in range(3)]
            import hashlib
            name = hashlib.sha256(component['component_key'].encode()).hexdigest()[:24] + '.glb'
            path = 'resources/' + name
            try:
                bpy.ops.export_scene.gltf(filepath=str(output / path), export_format='GLB', use_selection=True,
                                          export_animations=False, export_extras=True, export_yup=True)
            finally:
                root.parent = parent
                root.matrix_world = original
                bpy.context.view_layer.update()
            result['components'][component['component_key']] = {
                'path': path, 'bounds': {'minimum': minimum, 'maximum': maximum},
                'body_to_visual': {'position': [(minimum[0]+maximum[0])/2, minimum[1], (minimum[2]+maximum[2])/2],
                                   'quaternion': [0, 0, 0, 1]}}
    except Exception as error:
        result['error'] = {'source_path': current['source_path'] if current else None, 'message': str(error)}
    (output / 'blender-result.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    job_file = Path(sys.argv[sys.argv.index('--')+1])
    main(json.loads(job_file.read_text()))
