"""Bounded selected-fact custody independent of GPU and network imports."""
from collections import deque
import threading
import time

class PhysicsOwner:
    """One step owner, bounded selected facts retained across handoff until durable ACK."""
    def __init__(self, run, encode, limits):
        self.run = run
        self.encode = encode
        self.limits = limits
        self.condition = threading.Condition()
        self.facts = deque()
        self.bytes = 0
        self.sequence = 0
        self.sent_sequence = 0
        self.running = False
        self.closed = False
        self.failure = None
        self.request = None
        self.thread = threading.Thread(target=self.loop, name='newton-physics-owner', daemon=False)
        self.thread.start()

    def select(self):
        self.sequence += 1
        snapshot = self.run.sample()
        frame = self.encode(snapshot, self.sequence)
        with self.condition:
            if len(self.facts) >= self.limits['source_frames'] or self.bytes+len(frame) > self.limits['source_bytes']:
                raise RuntimeError('Reliable selected source capacity exhausted')
            self.facts.append((self.sequence,snapshot['sim_time_ns'],frame))
            self.bytes += len(frame)
            return self.facts[-1]

    def ack(self, sequence):
        with self.condition:
            while self.facts and self.facts[0][0] <= sequence:
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
            self.running = True
            self.condition.notify_all()

    def loop(self):
        try:
            self.select()
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.closed or self.request or self.running)
                    if self.closed:
                        return
                    request = self.request
                    self.request = None
                started = time.monotonic()
                if request:
                    done,result = request
                    result.append(self.select())
                    done.set()
                    continue
                # GPU work never holds the facts lock or waits for transport.
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

    def close(self):
        with self.condition:
            self.closed = True
            self.running = False
            self.condition.notify_all()
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            raise RuntimeError('Physics owner did not stop; supervisor must terminate this process')
