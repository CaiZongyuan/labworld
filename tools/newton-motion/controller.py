"""Session-local robot trajectories and measured outcomes; called only by PhysicsOwner."""
import json
import math

CAPABILITIES = ('robot.home', 'robot.move_joints', 'robot.set_gripper', 'robot.cancel')
POSITION_TOLERANCE = .02
VELOCITY_TOLERANCE = .05
STABLE_SAMPLES = 10
COMMAND_CAPACITY = 4096
COMMAND_BYTES = 4 * 1024 * 1024


class RobotController:
    def __init__(self, profile, subject):
        self.profile = profile
        self.subject = dict(subject)
        self.hold = tuple(profile['initial_joints'])
        self.last_target = self.hold
        self.active = None
        self.commands = {}
        self.command_bytes = 0
        self.pending = []
        self.phase = 'idle'
        self.last_sample_time = None
        self.last_observation_time = None
        self.velocity_stable = 0

    def event(self, kind, sample, event):
        fact = {'event_type': kind, 'subject': self.subject,
                'sim_time_ns': str(sample['sim_time_ns']), 'observed_at': None, 'event': event}
        self.pending.append(fact)
        return fact

    def observation(self, sample):
        self.event('robot.observation', sample, {'joints': list(sample['joints']),
                   'velocity': list(sample['velocity']), 'phase': self.phase})
        self.last_observation_time = sample['sim_time_ns']

    def task(self, command, status, sample, reason=None):
        event = {'command_id': command['command_id'], 'task_id': command['task_id'],
                 'status': status, 'phase': self.phase, 'reason': reason,
                 'joints': list(sample['joints']), 'velocity': list(sample['velocity'])}
        self.commands[command['command_id']]['receipt'] = self.event('robot.task', sample, event)
        self.observation(sample)

    def accept(self, payload, sample, paused):
        """Payload is immutable canonical JSON, already validated against admission."""
        command = json.loads(payload)
        previous = self.commands.get(command['command_id'])
        if previous is not None:
            if previous['payload'] != payload:
                raise ValueError('Altered robot command duplicate')
            # The exact previous receipt is replayed, with a fresh source-event identity.
            if previous['receipt'] is not None:
                self.pending.append(previous['receipt'])
            return
        reservation = len(payload)+1024  # Includes the bounded latest receipt and ledger metadata.
        if len(self.commands) >= COMMAND_CAPACITY or self.command_bytes+reservation > COMMAND_BYTES:
            raise RuntimeError('Robot command deduplication capacity exhausted')
        self.command_bytes += reservation
        self.commands[command['command_id']] = {'payload': payload, 'receipt': None}
        capability = command['capability']
        if capability == 'robot.cancel':
            if self.active is None:
                self.task(command, 'completed', sample)
                return
            if command['task_id'] != self.active['command']['task_id']:
                self.task(command, 'failed', sample, 'task_mismatch')
                return
            if self.active.get('cancel') is not None:
                self.task(command, 'failed', sample, 'robot_busy')
                return
            # Holding the gripper's last target retains existing grip pressure.
            self.hold = tuple(sample['joints'][:5]) + (self.last_target[5],)
            self.last_target = self.hold
            self.active.update(cancel=command, stable=0,
                               deadline=sample['sim_time_ns'] + 6_000_000_000)
            self.phase = 'cancelling'
            self.task(self.active['command'], 'cancel_requested', sample)
            self.task(command, 'cancel_requested', sample)
            if self.velocity_stable >= STABLE_SAMPLES:
                self.finish_cancel(sample)
            return
        if paused:
            self.task(command, 'failed', sample, 'session_paused')
            return
        if self.active is not None:
            self.task(command, 'failed', sample, 'robot_busy')
            return
        if capability == 'robot.home':
            target = tuple(self.profile['initial_joints'])
        elif capability == 'robot.move_joints':
            target = tuple(command['parameters']['joints'])
        elif capability == 'robot.set_gripper':
            target = tuple(sample['joints'][:5]) + (command['parameters']['position'],)
        else:
            raise ValueError('Unsupported robot capability')
        start = tuple(sample['joints'])
        duration = max(.5, max(abs(a-b) for a,b in zip(start,target,strict=True)) / .7)
        duration_ns = math.ceil(duration * 1_000_000_000)
        self.active = {'command': command, 'start': start, 'target': target,
                       'start_time': sample['sim_time_ns'], 'duration': duration_ns,
                       'deadline': sample['sim_time_ns'] + duration_ns + 6_000_000_000,
                       'stable': 0, 'cancel': None}
        self.phase = 'moving'
        self.task(command, 'running', sample)

    def targets(self, sim_time_ns):
        if self.active is None or self.active['cancel'] is not None:
            self.last_target = self.hold
        else:
            active = self.active
            fraction = min(1., max(0., (sim_time_ns-active['start_time']) / active['duration']))
            fraction = fraction * fraction * (3-2*fraction)
            self.last_target = tuple(a+(b-a)*fraction for a,b in zip(active['start'],active['target'],strict=True))
        return self.last_target

    def finish_cancel(self, sample):
        active = self.active
        self.phase = 'idle'
        self.task(active['command'], 'cancelled', sample)
        self.task(active['cancel'], 'completed', sample)
        self.active = None

    def observe(self, sample):
        if (len(sample['joints']) != 6 or len(sample['velocity']) != 6 or
                not all(math.isfinite(x) for x in (*sample['joints'], *sample['velocity']))):
            raise ValueError('Invalid measured robot state')
        sim_time = sample['sim_time_ns']
        progressed = self.last_sample_time is not None and sim_time > self.last_sample_time
        if self.last_sample_time is not None and sim_time < self.last_sample_time:
            raise ValueError('Robot simulation time regressed')
        self.last_sample_time = sim_time
        velocity_ok = all(abs(v) <= VELOCITY_TOLERANCE for v in sample['velocity'])
        if progressed:
            self.velocity_stable = self.velocity_stable+1 if velocity_ok else 0
        active = self.active
        if active is not None and progressed:
            cancelling = active['cancel'] is not None
            target = self.hold if cancelling else active['target']
            count = 5 if cancelling else 6
            position_ok = all(abs(a-b) <= POSITION_TOLERANCE for a,b in zip(sample['joints'][:count],target[:count],strict=True))
            trajectory_done = cancelling or sim_time >= active['start_time']+active['duration']
            active['stable'] = active['stable']+1 if trajectory_done and position_ok and velocity_ok else 0
            if active['stable'] >= STABLE_SAMPLES:
                if cancelling:
                    self.finish_cancel(sample)
                else:
                    self.hold = active['target']
                    self.phase = 'idle'
                    self.task(active['command'], 'completed', sample)
                    self.active = None
            elif sim_time >= active['deadline']:
                self.hold = tuple(sample['joints'][:5]) + (self.last_target[5],)
                self.phase = 'idle'
                self.task(active['command'], 'failed', sample, 'target_not_reached')
                if cancelling:
                    self.task(active['cancel'], 'failed', sample, 'target_not_reached')
                self.active = None
            elif trajectory_done and self.phase == 'moving':
                self.phase = 'settling'
                self.task(active['command'], 'running', sample)
        if self.last_observation_time is None or sim_time-self.last_observation_time >= 1_000_000_000:
            self.observation(sample)
        events, self.pending = self.pending, []
        return events
