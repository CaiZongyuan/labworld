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


@wp.kernel
def gather_state(body: wp.array(dtype=wp.transform), joint: wp.array(dtype=wp.float32),
                 bodies: wp.array(dtype=wp.int32), joints: wp.array(dtype=wp.int32),
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
    else:
        output[i] = joint[joints[i - bodies.shape[0] * 7]]


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
            builder.add_mjcf(str(self.directory/'instance.xml'), collapse_fixed_joints=False,
                             enable_self_collisions=True)
            indices = resolve(builder.joint_label, profile['joint_order'])
            for index, value in zip(indices, profile['initial_joints'], strict=True):
                builder.joint_q[builder.joint_q_start[index]] = value
            self.model = builder.finalize()
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
            target_starts = self.model.joint_target_q_start.numpy().tolist()
            self.target_indices = [target_starts[i] for i in joint_indices]
            self.target = self.control.joint_target_q.numpy().copy()
            self.gather_bodies = wp.array(self.body_indices, dtype=wp.int32)
            self.gather_joints = wp.array(self.coord_indices, dtype=wp.int32)
            self.sample_buffer = wp.empty(len(self.body_indices)*7+len(self.coord_indices), dtype=wp.float32)
            self.solver = newton.solvers.SolverMuJoCo(self.model, **profile['solver_configuration'])
            self.contacts = newton.Contacts(self.solver.mjw_data.naconmax, 0, device=self.device,
                                           requested_attributes={'force'})
            initial = self.sample()
            for actual_pose, expected in zip(initial['poses'], profile['initial_poses'], strict=True):
                for name in ('position','quaternion'):
                    if any(abs(a-b) > max(.00001, abs(b)*.000001) for a,b in zip(actual_pose[name],expected[name],strict=True)):
                        raise ValueError('Newton t0 disagrees with independently authored scene FK')
            if any(abs(a-b) > .00001 for a,b in zip(initial['joints'], profile['initial_joints'],strict=True)):
                raise ValueError('Newton t0 joints disagree with snapshot')
            # Capture only fixed solver work; readback and network are outside the graph.
            self.set_control(profile['initial_joints'])
            with wp.ScopedCapture(device=self.device) as capture:
                for _ in range(8):
                    self.solver.step(self.state, self.other, self.control, None, 1/240)
                    self.state, self.other = self.other, self.state
            self.graph = capture.graph
            self.physical_sample()
        self.metrics['setup_ms'] = (time.monotonic()-setup)*1000

    def set_control(self, values):
        for index, value, bounds in zip(self.target_indices, values, self.profile['joint_limits'], strict=True):
            if not bounds[0] <= value <= bounds[1]:
                raise ValueError('Joint target outside fixed profile limits')
            self.target[index] = value
        self.control.joint_target_q.assign(self.target)

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
        with wp.ScopedDevice(self.device):
            control_started=time.monotonic()
            self.set_control(self.control_values())
            self.metrics['control_ms'].append((time.monotonic()-control_started)*1000)
            self.metrics['control_ms']=self.metrics['control_ms'][-900:]
            started = time.monotonic()
            wp.capture_launch(self.graph)
            wp.synchronize_device(self.device)
            self.metrics['step_ms'].append((time.monotonic()-started)*1000)
            self.metrics['step_ms'] = self.metrics['step_ms'][-900:]
            self.metrics['step_batches'] += 1
        self.step_count += 8

    def sample(self, diagnostic=False):
        with wp.ScopedDevice(self.device):
            started = time.monotonic()
            wp.launch(gather_state, dim=len(self.sample_buffer),
                      inputs=[self.state.body_q,self.state.joint_q,self.gather_bodies,self.gather_joints],
                      outputs=[self.sample_buffer])
            values = self.sample_buffer.numpy().copy()
            if not diagnostic:
                self.metrics['readback_ms'].append((time.monotonic()-started)*1000)
                self.metrics['readback_ms'] = self.metrics['readback_ms'][-900:]
        if not np.isfinite(values).all():
            raise ValueError('Nonfinite Newton state')
        self.last_native = {'step':self.step_count,'phase':self.last_phase,
                            'poses':values[:len(self.body_indices)*7].reshape((-1,7)).tolist(),
                            'joints':values[len(self.body_indices)*7:].tolist()}
        poses = []
        for i, expected in enumerate(self.profile['initial_poses']):
            native = values[i*7:(i+1)*7].tolist()
            pose = wire_pose(native[:3], native[3:])
            # Quaternion sign carries no physical difference; fix it for the exact t0 contract.
            if sum(a*b for a,b in zip(pose['quaternion'],expected['quaternion'],strict=True)) < 0:
                pose['quaternion'] = tuple(-v for v in pose['quaternion'])
            poses.append(pose)
        return {'poses': poses, 'joints': values[len(poses)*7:].tolist(),
                'sim_time_ns': self.step_count*1_000_000_000//240}

    def physical_sample(self):
        """Explicit diagnostic scope; contact/velocity readback is separate from live pose readback."""
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
                'joints': sample['joints'], 'forces': totals, 'upright': float(upright),
                'released': released, 'seated': bool(seated), 'vial_z': vial_pose[2],
                'bilateral': totals['fixed'] > 1e-6 and totals['moving'] > 1e-6}


from facts_owner import PhysicsOwner
