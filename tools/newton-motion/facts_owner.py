"""Bounded selected-fact custody independent of GPU and network imports."""
from collections import deque
import json
import threading
import time

class PhysicsOwner:
    """One step owner, bounded selected facts retained across handoff until durable ACK."""
    def __init__(self, run, encode, limits, controller=None):
        self.run = run
        self.encode = encode
        self.limits = limits
        self.controller = controller
        self.condition = threading.Condition()
        self.facts = deque()
        self.events = {}
        self.event_count = 0
        self.commands = deque()
        self.command_bytes = 0
        self.bytes = 0
        self.sequence = 0
        self.sent_sequence = 0
        self.running = False
        self.closed = False
        self.accepting_commands = True
        self.failure = None
        self.request = None
        self.boundary_held = False
        self.thread = threading.Thread(target=self.loop, name='newton-physics-owner', daemon=False)
        self.thread.start()

    def select(self, snapshot=None):
        self.sequence += 1
        snapshot = self.run.sample() if snapshot is None else snapshot
        events = self.controller.observe(snapshot) if self.controller is not None else []
        if self.controller is not None:
            self.run.last_phase = self.controller.phase
        encoded_events = tuple(json.dumps(event,separators=(',',':')).encode('utf-8') for event in events)
        event_bytes = sum(map(len,encoded_events))
        frame = self.encode(snapshot, self.sequence)
        with self.condition:
            if (len(self.facts) >= self.limits['source_frames'] or
                    self.event_count+len(events) > self.limits.get('source_events',32) or
                    self.bytes+self.command_bytes+len(frame)+event_bytes > self.limits['source_bytes']):
                raise RuntimeError('Reliable selected source capacity exhausted')
            self.facts.append((self.sequence,snapshot['sim_time_ns'],frame))
            if encoded_events:
                self.events[self.sequence] = encoded_events
            self.event_count += len(events)
            self.bytes += len(frame)+event_bytes
            return self.facts[-1]

    def enqueue(self, command):
        if type(command) is not bytes or len(command)>16384:
            raise ValueError('Robot command must be immutable bounded bytes')
        with self.condition:
            if self.closed or self.failure or self.controller is None or not self.accepting_commands:
                raise RuntimeError('Robot source is unavailable')
            if len(self.commands)>=32 or self.bytes+self.command_bytes+len(command)>self.limits['source_bytes']:
                raise RuntimeError('Robot command queue capacity exhausted')
            self.commands.append(command)
            self.command_bytes += len(command)
            self.condition.notify_all()

    def stop_commands(self):
        with self.condition:
            self.accepting_commands = False
            self.commands.clear()
            self.command_bytes = 0

    def selected_events(self, sequence):
        with self.condition:
            return self.events.get(sequence,())

    def handoff_events(self, sequence):
        """ReliableRecording owns these exact events after its bounded offers succeed."""
        with self.condition:
            events = self.events.pop(sequence,())
            self.bytes -= sum(map(len,events))
            self.event_count -= len(events)

    def ack(self, sequence):
        with self.condition:
            while self.facts and self.facts[0][0] <= sequence and not self.events.get(self.facts[0][0]):
                self.bytes -= len(self.facts.popleft()[2])

    def take(self):
        with self.condition:
            if self.failure:
                raise self.failure
            for fact in self.facts:
                if fact[0] > self.sent_sequence:
                    self.sent_sequence = fact[0]
                    return fact
            return None

    def boundary(self):
        with self.condition:
            if self.failure:
                raise self.failure
            if self.request is not None:
                raise RuntimeError('Concurrent source boundary')
            self.running = False
            self.boundary_held = True
            done = threading.Event()
            result = []
            self.request = (done,result)
            self.condition.notify_all()
        if not done.wait(self.limits['durability_timeout_ms']/1000):
            raise RuntimeError('Physics boundary timeout')
        if self.failure:
            raise self.failure
        return result[0]

    def resume(self):
        with self.condition:
            if self.closed or self.failure:
                raise RuntimeError('Physics source is unavailable')
            self.running = True
            self.condition.notify_all()

    def release_boundary(self):
        with self.condition:
            self.boundary_held = False
            self.condition.notify_all()

    def loop(self):
        current_request = None
        try:
            self.select()
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.closed or self.request or
                                            (self.commands and not self.boundary_held) or self.running)
                    if self.closed:
                        return
                    request = self.request
                    self.request = None
                    current_request = request
                    command = self.commands.popleft() if self.commands and request is None else None
                    if command is not None:
                        self.command_bytes -= len(command)
                    paused = not self.running
                started = time.monotonic()
                if request:
                    done,result = request
                    result.append(self.select())
                    done.set()
                    current_request = None
                    continue
                if command is not None:
                    snapshot = self.run.sample()
                    self.controller.accept(command,snapshot,paused)
                    self.run.set_control(self.controller.targets(snapshot['sim_time_ns']))
                    self.select(snapshot)
                    continue
                # GPU work never holds the facts lock or waits for transport.
                if self.controller is not None:
                    self.run.set_control(self.controller.targets(self.run.step_count*1_000_000_000//240))
                    self.run.last_phase = self.controller.phase
                self.run.step()
                self.select()
                remaining = max(0, 1/30-(time.monotonic()-started))
                with self.condition:
                    self.condition.wait(timeout=remaining)
        except BaseException as error:
            with self.condition:
                self.failure = error
                self.running = False
                if self.request:
                    self.request[0].set()
                if current_request:
                    current_request[0].set()

    def close(self):
        with self.condition:
            self.closed = True
            self.running = False
            self.condition.notify_all()
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            raise RuntimeError('Physics owner did not stop; supervisor must terminate this process')
