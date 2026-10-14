"""One fixed GPU world. Solver/control, selected sampling and network ownership are separate."""
import hashlib
import json
import math
from pathlib import Path
import time

import numpy as np
import warp as wp
import newton

from coordinates import wire_pose, native_pose
from budget import NativeBudgetError, validate_native_budget


@wp.kernel
def observe_budget(nacon: wp.array(dtype=wp.int32), ncollision: wp.array(dtype=wp.int32),
                   nefc: wp.array(dtype=wp.int32), overflow: wp.array(dtype=wp.int32),
                   peaks: wp.array(dtype=wp.int32)):
    wp.atomic_max(peaks,0,nacon[0])
    wp.atomic_max(peaks,1,ncollision[0])
    wp.atomic_max(peaks,2,nefc[0])
    wp.atomic_max(peaks,3,overflow[0])


@wp.kernel
def gather_state(body: wp.array(dtype=wp.transform), joint: wp.array(dtype=wp.float32),
                 velocity: wp.array(dtype=wp.float32), bodies: wp.array(dtype=wp.int32),
                 joints: wp.array(dtype=wp.int32), dofs: wp.array(dtype=wp.int32),
                 output: wp.array(dtype=wp.float32)):
    i = wp.tid()
    if i < bodies.shape[0] * 7:
        index = i // 7
        component = i % 7
        transform = body[bodies[index]]
        if component < 3:
            output[i] = wp.transform_get_translation(transform)[component]
        else:
            output[i] = wp.transform_get_rotation(transform)[component - 3]
    elif i < bodies.shape[0] * 7 + joints.shape[0]:
        output[i] = joint[joints[i - bodies.shape[0] * 7]]
    else:
        output[i] = velocity[dofs[i - bodies.shape[0] * 7 - joints.shape[0]]]


def resolve(labels, keys):
    names = [label.rsplit('/', 1)[-1] for label in labels]
    result = []
    for key in keys:
        name = key.rsplit('/', 1)[-1]
        if names.count(name) != 1:
            raise ValueError('Missing or ambiguous runtime key: ' + key)
        result.append(names.index(name))
    return result


class NewtonRun:
    def __init__(self, profile, directory):
        self.profile = profile
        self._budget_failed = False
        self._previous_contact_filter = None
        self.graphs = []
        self.directory = Path(directory).resolve()
        from scene_loader import supported_profile
        actual = supported_profile()
        if actual['hash'] != profile['hash'] or any(profile[key]!=value for key,value in actual.items() if key!='initial_poses'):
            raise ValueError('Fixed Newton profile mismatch')
        for entry in actual['source']['files']:
            path = self.directory / 'assets' / Path(entry['path']).name
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
                raise ValueError('Pinned physics mesh changed')
        if 'sha256:' + hashlib.sha256((self.directory/'scene.xml').read_bytes()).hexdigest() != profile['scene_sha256']:
            raise ValueError('Pinned scene changed')
        if profile['profile_id'] != 'so101-vial-v1' or profile['physics_step_hz'] != 240 or profile['sample_hz'] != 30:
            raise ValueError('Unsupported Newton profile')
        newton.use_coord_layout_targets = True
        np.random.seed(profile['seed'])
        wp.init()
        self.device = wp.get_device('cuda:0')
        if not self.device.is_cuda:
            raise ValueError('Newton profile requires CUDA')
        self.step_count = 0
        self.control_mode = 'demo'
        self.last_phase = 'static'
        self.metrics = {'setup_ms': 0, 'step_batches': 0, 'step_ms': [], 'control_ms': [], 'readback_ms': [], 'physical_readback_ms': [], 'encode_ms': []}
        setup = time.monotonic()
        with wp.ScopedDevice(self.device):
            import xml.etree.ElementTree as ET
            tree = ET.parse(self.directory/'scene.xml')
            for name,index in [('base',0),('vial',7),('rack',8),('mat',9)]:
                source = native_pose(profile['initial_poses'][index]['position'],profile['initial_poses'][index]['quaternion'])
                body = tree.find(f"worldbody/body[@name='{name}']")
                body.set('pos',' '.join(map(str,source['position'])))
                x,y,z,w = source['quaternion']
                body.set('quat',' '.join(map(str,(w,x,y,z))))
            tree.write(self.directory/'instance.xml',encoding='utf-8',xml_declaration=True)
            builder = newton.ModelBuilder(up_axis=newton.Axis.Z)
            builder.rigid_gap = profile['collision_discovery']['shape_gap_m']
            builder.add_mjcf(str(self.directory/'instance.xml'), collapse_fixed_joints=False,
                             enable_self_collisions=True)
            indices = resolve(builder.joint_label, profile['joint_order'])
            for index, value in zip(indices, profile['initial_joints'], strict=True):
                builder.joint_q[builder.joint_q_start[index]] = value
            self.model = builder.finalize()
            if np.any(self.model.shape_gap.numpy() != 0) or np.any(self.model.shape_margin.numpy() != 0):
                self.close()
                raise ValueError('Fixed discovery gap must be zero; activation margin must remain zero')
            self.state = self.model.state()
            self.other = self.model.state()
            self.control = self.model.control()
            newton.eval_fk(self.model, self.model.joint_q, self.model.joint_qd, self.state)
            self.body_indices = resolve(self.model.body_label, profile['body_order'])
            joint_indices = resolve(self.model.joint_label, profile['joint_order'])
            starts = self.model.joint_q_start.numpy().tolist()
            types = self.model.joint_type.numpy().tolist()
            self.coord_indices = [starts[i] for i in joint_indices]
            if any(types[i] != int(newton.JointType.REVOLUTE) or starts[i+1]-starts[i] != 1 for i in joint_indices):
                raise ValueError('Fixed profile joints must resolve to one angular coordinate')
            dof_starts = self.model.joint_qd_start.numpy().tolist()
            self.dof_indices = [dof_starts[i] for i in joint_indices]
            if any(dof_starts[i+1]-dof_starts[i] != 1 for i in joint_indices):
                raise ValueError('Fixed profile joints must resolve to one angular velocity')
            target_starts = self.model.joint_target_q_start.numpy().tolist()
            self.target_indices = [target_starts[i] for i in joint_indices]
            self.target = self.control.joint_target_q.numpy().copy()
            self.gather_bodies = wp.array(self.body_indices, dtype=wp.int32)
            self.gather_joints = wp.array(self.coord_indices, dtype=wp.int32)
            self.gather_dofs = wp.array(self.dof_indices, dtype=wp.int32)
            self.sample_buffer = wp.empty(len(self.body_indices)*7+2*len(self.coord_indices), dtype=wp.float32)
            self.solver = newton.solvers.SolverMuJoCo(self.model, **profile['solver_configuration'])
            try:
                self.initial_native_budget = self.check_native_budget('constructor',initial=True)
                if np.any(self.solver.mj_model.geom_gap != 0) or np.any(self.solver.mj_model.geom_margin != 0):
                    raise ValueError('Compiled geom discovery/activation parameters differ from fixed candidate')
                if np.any(self.solver.mj_model.pair_gap != 0) or np.any(self.solver.mj_model.pair_margin != 0):
                    raise ValueError('Compiled explicit pair discovery/activation parameters differ')
            except BaseException:
                self.close()
                raise
            self.contacts = newton.Contacts(256, 0, device=self.device,
                                           requested_attributes={'force'})
            initial = self.sample()
            for actual_pose, expected in zip(initial['poses'], profile['initial_poses'], strict=True):
                for name in ('position','quaternion'):
                    if any(abs(a-b) > max(.00001, abs(b)*.000001) for a,b in zip(actual_pose[name],expected[name],strict=True)):
                        raise ValueError('Newton t0 disagrees with independently authored scene FK')
            if any(abs(a-b) > .00001 for a,b in zip(initial['joints'], profile['initial_joints'],strict=True)):
                raise ValueError('Newton t0 joints disagree with snapshot')
            # A collision-pass observer retains peaks before sleeping-pass counters reset.
            self.budget_peaks = wp.zeros(4,dtype=wp.int32,device=self.device)
            self._previous_contact_filter = self.solver.mjw_model.callback.contactfilter
            self.solver.mjw_model.callback.contactfilter = self.observe_collision_pass
            self.set_control(profile['initial_joints'])
            # Each graph contains one actual native step. Host rejection occurs
            # before the next substep, while a public sample still spans eight steps.
            for state_in,state_out in [(self.state,self.other),(self.other,self.state)]:
                with wp.ScopedCapture(device=self.device) as capture:
                    self.budget_peaks.zero_()
                    self.solver.step(state_in,state_out,self.control,None,1/240)
                    self.launch_budget_observer(self.solver.mjw_data)
                self.graphs.append(capture.graph)
            self.physical_sample()
        self.metrics['setup_ms'] = (time.monotonic()-setup)*1000

    def set_control(self, values):
        for index, value, bounds in zip(self.target_indices, values, self.profile['joint_limits'], strict=True):
            if not bounds[0] <= value <= bounds[1]:
                raise ValueError('Joint target outside fixed profile limits')
            self.target[index] = value
        self.control.joint_target_q.assign(self.target)

    def controlled(self):
        if self.step_count:
            raise ValueError('Control mode must be selected before stepping')
        self.control_mode = 'controlled'
        self.last_phase = 'idle'

    def control_values(self):
        begin = 0
        previous = self.profile['initial_joints']
        for stage in self.profile['program']:
            if self.step_count < stage['end_step']:
                fraction = (self.step_count-begin)/(stage['end_step']-begin)
                self.last_phase = stage['phase']
                return [a+(b-a)*fraction for a,b in zip(previous,stage['joints'],strict=True)]
            begin, previous = stage['end_step'], stage['joints']
        self.last_phase = 'rest'
        return previous

    def step(self):
        if self._budget_failed:
            raise RuntimeError('Newton native budget is latched closed')
        with wp.ScopedDevice(self.device):
            control_started=time.monotonic()
            if self.control_mode == 'demo':
                self.set_control(self.control_values())
            self.metrics['control_ms'].append((time.monotonic()-control_started)*1000)
            self.metrics['control_ms']=self.metrics['control_ms'][-900:]
            started = time.monotonic()
            for substep in range(8):
                wp.capture_launch(self.graphs[self.step_count % 2])
                wp.synchronize_device(self.device)
                self.step_count += 1
                try:
                    self.check_native_budget('native-step-' + str(self.step_count),peaks=True)
                except BaseException:
                    self._budget_failed = True
                    raise
            self.metrics['step_ms'].append((time.monotonic()-started)*1000)
            self.metrics['step_ms'] = self.metrics['step_ms'][-900:]
            self.metrics['step_batches'] += 1

    def launch_budget_observer(self,data):
        wp.launch(observe_budget,dim=1,inputs=[data.nacon,data.ncollision,data.nefc,data.overflow],outputs=[self.budget_peaks])

    def observe_collision_pass(self,model,data):
        self.launch_budget_observer(data)
        if self._previous_contact_filter is not None:
            self._previous_contact_filter(model,data)
            self.launch_budget_observer(data)

    def check_native_budget(self,phase,initial=False,peaks=False):
        try:
            data=self.solver.mjw_data
            snapshot={key:int(getattr(data,key)) for key in ['nworld','naconmax','njmax']}
            for key in ['nacon','ncollision','nefc','overflow']:
                values=getattr(data,key).numpy().reshape(-1)
                if len(values)!=1:
                    raise ValueError('Expected one logical native count for ' + key)
                snapshot[key]=int(values[0])
            if initial:
                snapshot.update(cpu_ncon=int(self.solver.mj_data.ncon),cpu_nefc=int(self.solver.mj_data.nefc))
            if peaks:
                values=self.budget_peaks.numpy().tolist()
                if len(values)!=4:raise ValueError('Missing actual collision-pass peaks')
                for key,value in zip(['nacon','ncollision','nefc','overflow'],values,strict=True):
                    snapshot[key]=max(snapshot[key],int(value))
        except (AttributeError,TypeError,ValueError) as error:
            self._budget_failed=True
            raise NativeBudgetError(phase,{},'actual native getter unavailable: ' + str(error)) from error
        try:
            validate_native_budget(snapshot,phase,initial)
        except NativeBudgetError:
            self._budget_failed=True
            raise
        self.last_native_budget=snapshot
        return snapshot

    def close(self):
        self._budget_failed=True
        solver=getattr(self,'solver',None)
        if solver is not None:
            solver.mjw_model.callback.contactfilter=self._previous_contact_filter
            solver.close_mujoco_viewer()
        self.graphs.clear()
        for name in ['contacts','solver','model','state','other','control','budget_peaks','sample_buffer','gather_bodies','gather_joints','gather_dofs']:
            setattr(self,name,None)

    def sample(self, diagnostic=False):
        if self._budget_failed:raise RuntimeError('Newton native budget is latched closed')
        with wp.ScopedDevice(self.device):
            started = time.monotonic()
            wp.launch(gather_state, dim=len(self.sample_buffer),
                      inputs=[self.state.body_q,self.state.joint_q,self.state.joint_qd,self.gather_bodies,self.gather_joints,self.gather_dofs],
                      outputs=[self.sample_buffer])
            values = self.sample_buffer.numpy().copy()
            if not diagnostic:
                self.metrics['readback_ms'].append((time.monotonic()-started)*1000)
                self.metrics['readback_ms'] = self.metrics['readback_ms'][-900:]
        if not np.isfinite(values).all():
            raise ValueError('Nonfinite Newton state')
        joint_start = len(self.body_indices)*7
        joint_end = joint_start+len(self.coord_indices)
        self.last_native = {'step':self.step_count,'phase':self.last_phase,
                            'poses':values[:len(self.body_indices)*7].reshape((-1,7)).tolist(),
                            'joints':values[joint_start:joint_end].tolist(),
                            'velocity':values[joint_end:].tolist()}
        poses = []
        for i, expected in enumerate(self.profile['initial_poses']):
            native = values[i*7:(i+1)*7].tolist()
            pose = wire_pose(native[:3], native[3:])
            # Quaternion sign carries no physical difference; fix it for the exact t0 contract.
            if sum(a*b for a,b in zip(pose['quaternion'],expected['quaternion'],strict=True)) < 0:
                pose['quaternion'] = tuple(-v for v in pose['quaternion'])
            poses.append(pose)
        return {'poses': poses, 'joints': values[joint_start:joint_end].tolist(),
                'velocity':values[joint_end:].tolist(),
                'sim_time_ns': self.step_count*1_000_000_000//240}

    def physical_sample(self):
        """Explicit diagnostic scope; contact/velocity readback is separate from live pose readback."""
        if self._budget_failed:raise RuntimeError('Newton native budget is latched closed')
        started=time.monotonic()
        with wp.ScopedDevice(self.device):
            self.solver.update_contacts(self.contacts, self.state)
            count = int(self.contacts.rigid_contact_count.numpy()[0])
            first = self.contacts.rigid_contact_shape0.numpy()[:count]
            second = self.contacts.rigid_contact_shape1.numpy()[:count]
            force = self.contacts.force.numpy()[:count]
            shape_body = self.model.shape_body.numpy()
            native = self.state.body_q.numpy()
            velocity = self.state.body_qd.numpy()[self.body_indices[7]]
        totals = {'fixed': 0.0, 'moving': 0.0, 'rack': 0.0}
        vial = self.body_indices[7]
        for a,b,f in zip(first,second,force,strict=True):
            body_a, body_b = int(shape_body[a]), int(shape_body[b])
            if vial not in (body_a,body_b):
                continue
            other = body_b if body_a == vial else body_a
            for name,index in [('fixed',5),('moving',6),('rack',8)]:
                if other == self.body_indices[index]:
                    totals[name] += float(np.linalg.norm(f[:3]))
        vial_pose = native[vial].tolist()
        from coordinates import rotate
        upright = rotate(vial_pose[3:], (0,0,1))[2]
        sample = self.sample(diagnostic=True)
        openness = (sample['joints'][-1]-self.profile['joint_limits'][-1][0]) / (self.profile['joint_limits'][-1][1]-self.profile['joint_limits'][-1][0])
        released = totals['fixed'] < 1e-6 and totals['moving'] < 1e-6 and openness > .20
        rack = native[self.body_indices[8],:3]
        local = native[vial,:3]-rack
        seated = (all(a < value < b for a,value,b in zip(self.profile['criteria']['rack_lower'],local,self.profile['criteria']['rack_upper'],strict=True))
                  and upright > .90 and released and float(np.linalg.norm(velocity[:3])) < .06
                  and float(np.linalg.norm(velocity[3:])) < .8)
        self.metrics['physical_readback_ms'].append((time.monotonic()-started)*1000)
        self.metrics['physical_readback_ms']=self.metrics['physical_readback_ms'][-900:]
        return {'step': self.step_count, 'phase': self.last_phase, 'native_poses': native[self.body_indices].tolist(),
                'joints': sample['joints'], 'velocity':sample['velocity'], 'forces': totals, 'upright': float(upright),
                'released': released, 'seated': bool(seated), 'vial_z': vial_pose[2],
                'bilateral': totals['fixed'] > 1e-6 and totals['moving'] > 1e-6}


from facts_owner import PhysicsOwner
