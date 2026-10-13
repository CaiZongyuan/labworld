"""Formal Isaac Lab recording hooks; the adapter never owns the source solver."""
import json
from pathlib import Path
import uuid

import numpy as np
import warp as wp
from isaaclab.managers import RecorderManagerBaseCfg, RecorderTerm, RecorderTermCfg
from isaaclab.managers.recorder_manager import DatasetExportMode
from isaaclab.utils.configclass import configclass

from scene import describe, native_pose


def array(value):
    return wp.to_torch(value).detach().cpu().numpy().copy() if isinstance(value, wp.array) else value.detach().cpu().numpy().copy()


class SourceRecorder(RecorderTerm):
    def __init__(self, cfg, env):
        super().__init__(cfg, env)
        from isaaclab_newton.physics import NewtonManager
        self.directory = Path(cfg.output_directory)
        self.run_id = cfg.source_run_id
        self.episode = -1
        self.sequence = 0
        self.model = NewtonManager.get_model()
        # Capture authored layout before the player performs reset or advances policy.
        env.sim.stage.Flatten().Export(str(self.directory / 'source-baseline.usdc'))
        metadata = json.loads(Path(cfg.metadata).read_text()) if cfg.metadata else {}
        self.description = describe(env.sim.stage, metadata)
        self.body_map = {x['source_path']: x for x in self.description['bodies']}
        self.body_labels = list(self.model.body_label)
        self.joint_labels = list(self.model.joint_label)
        self.joint_starts = self.model.joint_q_start.numpy().tolist()
        types = self.model.joint_type.numpy().tolist()
        parents = self.model.joint_parent.numpy().tolist()
        children = self.model.joint_child.numpy().tolist()
        import newton
        root = self.description['source_scene_baseline']['root_path']
        self.joints = []
        for index, label in enumerate(self.joint_labels):
            kind = newton.JointType(types[index]).name.lower()
            key = 'joint:' + label.removeprefix(root + '/').replace('/joints/', '/')
            supported = kind in ('revolute', 'prismatic') and self.joint_starts[index+1] - self.joint_starts[index] == 1
            self.joints.append({'joint_key': key, 'source_path': label,
                                'source_path_kind': 'usd-prim' if env.sim.stage.GetPrimAtPath(label) else 'native-label',
                                'type': kind, 'motion_supported': supported,
                                'coordinate_key': key + '/position' if supported else None,
                                'unit': 'rad' if kind == 'revolute' and supported else 'm' if supported else None,
                                'parent_body_key': self.body_map.get(self.body_labels[parents[index]], {}).get('body_key') if parents[index] >= 0 else None,
                                'child_body_key': self.body_map.get(self.body_labels[children[index]], {}).get('body_key') if children[index] >= 0 else None})
        self.native_model = {'bodies': self.description['bodies'], 'joints': self.joints,
                             'body_paths': self.body_labels, 'joint_paths': self.joint_labels,
                             'device': str(self.model.device), 'shape_count': int(self.model.shape_count)}
        self._write('native-model.json', self.native_model)

    def _write(self, name, value):
        (self.directory / name).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')

    def witness(self, clock, hook):
        """Independent Isaac Lab asset views, not the adapter's encoded poses."""
        transforms, joints = {}, {}
        for asset in self._env.scene.articulations.values():
            positions, rotations = array(asset.data.body_pos_w)[0], array(asset.data.body_quat_w)[0]
            names = asset.body_names
            root = asset.cfg.prim_path.replace('{ENV_REGEX_NS}', self._env.scene.env_prim_paths[0])
            root = root.replace('/World/envs/env_[^/]+', self._env.scene.env_prim_paths[0])
            for name, position, rotation in zip(names, positions, rotations, strict=True):
                transforms[root + '/' + name] = [*position.tolist(), *rotation.tolist()]
            values = array(asset.data.joint_pos)[0]
            for name, value in zip(asset.joint_names, values, strict=True):
                joints[root + '/joints/' + name] = float(value)
        for asset in self._env.scene.rigid_objects.values():
            root = asset.cfg.prim_path.replace('{ENV_REGEX_NS}', self._env.scene.env_prim_paths[0])
            root = root.replace('/World/envs/env_[^/]+', self._env.scene.env_prim_paths[0])
            transforms[root] = [*array(asset.data.root_pos_w)[0].tolist(), *array(asset.data.root_quat_w)[0].tolist()]
        return {'hook': hook, 'source_sim_time_ns': clock, 'coordinate_frame': 'rh-z-up-m',
                'body_transforms': transforms, 'joint_positions': joints, 'reader': 'IsaacLab articulation/rigid-object data views'}

    def sample(self, hook):
        from isaaclab_newton.physics import NewtonManager
        from isaaclab.physics import PhysicsManager
        state = NewtonManager.get_state()
        body_values = state.body_q.numpy().copy()
        joint_values = state.joint_q.numpy().copy()
        if not np.isfinite(body_values).all() or not np.isfinite(joint_values).all():
            raise ValueError('Nonfinite actual Newton source state')
        clock = str(round(PhysicsManager.get_simulation_time() * 1_000_000_000))
        self.sequence += 1
        poses = [{'pose_key': self.body_map[label]['pose_key'], **native_pose(values.tolist())}
                 for label, values in zip(self.body_labels, body_values, strict=True) if label in self.body_map]
        raw, coordinates = [], []
        for index, joint in enumerate(self.joints):
            values = joint_values[self.joint_starts[index]:self.joint_starts[index+1]].tolist()
            raw.append({'joint_key': joint['joint_key'], 'type': joint['type'], 'coordinates': values})
            if joint['motion_supported']:
                coordinates.append({'coordinate_key': joint['coordinate_key'], 'value': values[0]})
        frame = {'source_run_id': self.run_id, 'episode_id': str(self.episode), 'source_sequence': str(self.sequence),
                 'source_sim_time_ns': clock, 'poses': poses, 'joints': coordinates}
        witness = self.witness(clock, hook)
        terms = None if hook == 'post-reset' else {name: self._env.termination_manager.get_term(name).cpu().tolist()
                                                  for name in self._env.termination_manager.active_terms}
        fact = {'type': 'sample', 'hook': hook, 'state': frame, 'raw_joints': raw, 'termination': terms}
        with (self.directory / 'samples.jsonl').open('a') as file:
            file.write(json.dumps(fact, allow_nan=False) + '\n')
        with (self.directory / 'native-witness.jsonl').open('a') as file:
            file.write(json.dumps(witness, allow_nan=False) + '\n')
        self._write('current-snapshot.json', {'schema_version': 1, 'state': frame, 'native_model': self.native_model})
        if not (self.directory / 'initial-snapshot.json').exists():
            self._write('initial-snapshot.json', {'schema_version': 1, 'state': frame, 'native_model': self.native_model})
        return frame, terms

    def record_post_reset(self, env_ids):
        self.episode += 1
        self.sample('post-reset')
        return None, None

    def record_post_step(self):
        self.sample('post-step')
        return None, None

    def record_pre_reset(self, env_ids):
        if self.episode >= 0:
            frame, terms = self.sample('pre-reset')
            reasons = [name for name, value in terms.items() if any(value)]
            success = 'success' in reasons
            failure = any(name in reasons for name in ('vial_lost', 'unstable_robot'))
            result = 'succeeded' if success and not failure else 'failed' if failure and not success else 'unknown'
            with (self.directory / 'events.jsonl').open('a') as file:
                file.write(json.dumps({'type': 'experiment.ended', 'source_run_id': self.run_id,
                                       'episode_id': str(self.episode), 'source_sim_time_ns': frame['source_sim_time_ns'],
                                       'result': result, 'end_reasons': reasons, 'last_source_sequence': frame['source_sequence']}) + '\n')
        return None, None

    def close(self, file_path):
        # The containing source program owns env.close(), not this observer.
        pass


@configclass
class SourceRecorderCfg(RecorderTermCfg):
    class_type = SourceRecorder
    output_directory: str = ''
    source_run_id: str = ''
    metadata: str | None = None


@configclass
class SourceRecorders(RecorderManagerBaseCfg):
    dataset_export_mode = DatasetExportMode.EXPORT_NONE
    export_in_record_pre_reset = False
    export_in_close = False
    source = SourceRecorderCfg()


def recorders(directory, metadata=None, run_id=None):
    cfg = SourceRecorders()
    cfg.source = SourceRecorderCfg(output_directory=str(directory), source_run_id=run_id or str(uuid.uuid4()),
                                   metadata=str(metadata) if metadata else None)
    return cfg
