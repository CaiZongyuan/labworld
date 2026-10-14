"""Measured-control and reliable wire discriminators, without GPU dependencies."""
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import uuid

sys.path.insert(0,str(Path(__file__).parents[1]/'synthetic-motion'))
from controller import RobotController, STABLE_SAMPLES
from facts_owner import PhysicsOwner
from scene_loader import supported_profile
from recording_codec import (canonical, decode_packet, encode_packet, limits, parse_robot_command,
                             parse_robot_event, parse_source_event)
from recording_source import ReliableRecording
from motion_codec import MotionProtocolError

PROFILE = supported_profile()
SCOPE = {name:str(uuid.uuid4()) for name in ('recording_id','session_id','lease_id')}
SCOPE['epoch'] = '7'
ROBOT = {name:str(uuid.uuid4()) for name in ('entity_id','binding_id','run_id')}
SUBJECT = {'session_id':SCOPE['session_id'],**ROBOT}


def command(capability='robot.home', parameters=None, task_id=None):
    return {'type':'robot.command','version':1,**SCOPE,**ROBOT,'command_id':str(uuid.uuid4()),
            'task_id': task_id or str(uuid.uuid4()),'capability':capability,'parameters':parameters or {}}


def sample(sim_time=0, joints=None, velocity=None):
    return {'sim_time_ns':sim_time,'joints':list(PROFILE['initial_joints'] if joints is None else joints),
            'velocity':[0.]*6 if velocity is None else velocity}


class ControllerTests(unittest.TestCase):
    def controller(self):
        controller = RobotController(PROFILE,SUBJECT)
        controller.observe(sample())
        return controller

    def test_target_delivery_cannot_complete_without_measured_position_and_stability(self):
        controller = self.controller()
        target = [.2,0,0,0,0,.7]
        request = command('robot.move_joints',{'joints':target})
        controller.accept(canonical(request),sample(),False)
        controller.observe(sample())
        self.assertEqual(controller.targets(500_000_000),tuple(target))
        events = controller.observe(sample(600_000_000))
        self.assertFalse(any(e['event'].get('status')=='completed' for e in events))
        for index in range(STABLE_SAMPLES-1):
            events = controller.observe(sample(700_000_000+index*33_333_333,target))
            self.assertFalse(any(e['event'].get('status')=='completed' for e in events))
        events = controller.observe(sample(1_100_000_000,target))
        self.assertEqual([e['event']['status'] for e in events if e['event_type']=='robot.task'],['completed'])
        self.assertIsNone(controller.active)

    def test_blocked_gripper_reports_failure_from_measured_state(self):
        controller = self.controller()
        request = command('robot.set_gripper',{'position':.2})
        controller.accept(canonical(request),sample(),False)
        controller.targets(8_000_000_000)
        events = controller.observe(sample(8_000_000_000))
        task = next(e['event'] for e in events if e['event_type']=='robot.task' and e['event']['status']=='failed')
        self.assertEqual(task['reason'],'target_not_reached')
        self.assertEqual(task['joints'][-1],.7)

    def test_paused_cancel_preserves_grip_and_needs_resume_to_settle(self):
        controller = self.controller()
        request = command('robot.move_joints',{'joints':[.4,0,0,0,0,.4]})
        controller.accept(canonical(request),sample(),False)
        controller.targets(200_000_000)
        moving = sample(200_000_000,[.1,0,0,0,0,.6],[.3,0,0,0,0,.1])
        controller.observe(moving)
        grip_target = controller.last_target[-1]
        cancel = command('robot.cancel',task_id=request['task_id'])
        controller.accept(canonical(cancel),moving,True)
        self.assertEqual(controller.hold[:5],tuple(moving['joints'][:5]))
        self.assertEqual(controller.hold[-1],grip_target)
        for _ in range(30):
            events = controller.observe(sample(200_000_000,moving['joints']))
            self.assertFalse(any(e['event'].get('status') in ('completed','cancelled') for e in events))
        for index in range(STABLE_SAMPLES):
            events = controller.observe(sample(240_000_000+index*33_333_333,moving['joints']))
        tasks = [e['event'] for e in events if e['event_type']=='robot.task']
        self.assertEqual([(e['command_id'],e['status']) for e in tasks],[(request['command_id'],'cancelled'),(cancel['command_id'],'completed')])

    def test_duplicate_is_receipt_only_and_altered_envelope_fails_closed(self):
        controller = self.controller()
        request = command()
        payload = canonical(request)
        controller.accept(payload,sample(),False)
        active = controller.active
        controller.accept(payload,sample(100_000_000),False)
        self.assertIs(controller.active,active)
        self.assertEqual(len(controller.commands),1)
        request['parameters'] = {'unexpected':True}
        with self.assertRaisesRegex(ValueError,'Altered'):
            controller.accept(canonical(request),sample(),False)

    def test_stale_scope_bounds_and_robot_event_kind_are_independent_of_lifecycle(self):
        request = command('robot.move_joints',{'joints':PROFILE['initial_joints']})
        parse_robot_command(json.dumps(request),SCOPE,ROBOT,PROFILE['joint_limits'])
        for altered in [{**request,'epoch':'6'},{**request,'parameters':{'joints':[100,0,0,0,0,.7]}}]:
            with self.assertRaises(MotionProtocolError):
                parse_robot_command(json.dumps(altered),SCOPE,ROBOT,PROFILE['joint_limits'])
        controller = self.controller()
        controller.accept(canonical(request),sample(),False)
        event = controller.observe(sample())[0]
        event.update(source_event_sequence='1',event_id=str(uuid.uuid4()))
        encoded = canonical(event)
        parse_robot_event(encoded.decode())
        with self.assertRaises(MotionProtocolError):
            parse_source_event(encoded.decode())
        self.assertEqual(decode_packet(encode_packet(SCOPE,1,4,encoded),SCOPE)['kind'],4)

    def test_recording_counts_robot_events_against_the_reliable_event_budget(self):
        class Socket: pass
        recording = ReliableRecording(Socket(),SCOPE,{'limits':limits(),'source_prefix_sha256':'sha256:'+'0'*64,'robot':ROBOT})
        controller = self.controller()
        controller.accept(canonical(command()),sample(),False)
        event = controller.observe(sample())[0]
        recording.limits['source_events'] = 1
        recording.robot_event(event)
        with self.assertRaises(MotionProtocolError):
            recording.robot_event(event)
        self.assertEqual(recording.events,1)
        self.assertEqual(recording.event_sequence,1)

    def test_paused_owner_processes_commands_without_physics_or_network_thread_control(self):
        class Run:
            step_count = 0
            last_phase = 'idle'
            writers = []
            changed = threading.Event()
            def sample(self): return sample(self.step_count*1_000_000_000//240)
            def set_control(self,values):
                self.writers.append(threading.current_thread().name)
                self.changed.set()
            def step(self): self.step_count+=8
        run = Run()
        owner = PhysicsOwner(run,lambda measured,sequence:b'frame',limits(),RobotController(PROFILE,SUBJECT))
        try:
            owner.boundary()
            owner.enqueue(canonical(command()))
            self.assertFalse(run.changed.wait(.05),'Lifecycle boundary must precede command frames')
            owner.release_boundary()
            self.assertTrue(run.changed.wait(1))
            deadline = time.monotonic()+1
            statuses = []
            while 'failed' not in statuses:
                fact = owner.take()
                if fact:
                    statuses.extend(json.loads(e)['event'].get('status') for e in owner.selected_events(fact[0]))
                    owner.handoff_events(fact[0]); owner.ack(fact[0])
                self.assertLess(time.monotonic(),deadline)
                time.sleep(.001)
            self.assertEqual(run.step_count,0)
            self.assertEqual(run.writers,['newton-physics-owner'])
        finally:
            owner.close()


if __name__=='__main__': unittest.main()
