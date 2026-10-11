"""One bounded reliable collector and sender for a single admitted Session."""

import asyncio
import sys
import time
import uuid
from collections import deque
from pathlib import Path

from motion_codec import MotionProtocolError
from recording_codec import (CODEC, advance_prefix, canonical,
                             encode_frame_batch, encode_packet, identity, parse_ack,
                             parse_source_end, parse_source_event, sha256, verify_ready)


def implementation_header():
    """Source provenance; dependencies without an available distribution hash remain null."""
    import importlib.metadata

    names = ('motion_codec.py', 'synthetic.py', 'publisher.py', 'recording_codec.py', 'recording_source.py')
    root = Path(__file__).parent
    parts = []
    for name in names:
        data = (root / name).read_bytes()
        parts.extend((name.encode('ascii') + b'\0', len(data).to_bytes(4, 'little'), data))
    return {'source_kind': 'synthetic',
            'implementation': {'name': 'lab-word-synthetic', 'version': '1', 'sha256': sha256(b''.join(parts))},
            'python_version': '.'.join(map(str, sys.version_info[:3])),
            'dependencies': [{'name': 'websockets', 'version': importlib.metadata.version('websockets'), 'sha256': None}],
            'capture_policy': {'selection': 'all-selected', 'sample_hz': 30, 'motion_codec': 'pose-f32-v1',
                               'first_source_sequence': '1', 'first_source_event_sequence': '1'}}


class ReliableRecording:
    """Offers never await I/O. Every selected fact remains owned until its exact durable ACK."""

    def __init__(self, websocket, bootstrap, ready):
        self.websocket = websocket
        self.scope = bootstrap
        self.limits = ready['limits']
        self.prefix = ready['source_prefix_sha256']
        self.facts = deque()
        self.retained_bytes = 0
        self.frames = 0
        self.events = 0
        self.wake = asyncio.Event()
        self.changed = asyncio.Event()
        self.inflight = None
        self.last_ack = None
        self.packet_sequence = 0
        self.selected_sequence = 0
        self.event_sequence = 0
        self.durable_sequence = 0
        self.durable_event_sequence = 0
        self.ended = False
        self.ending = False
        self.retries = 0
        self.peak_retained_bytes = 0
        self.peak_transport_bytes = 0

    @property
    def deadline_seconds(self):
        return self.limits['durability_timeout_ms'] / 1000

    def offer(self, kind, payload, sequence=0, event_sequence=0, immediate=False):
        if self.ending or self.ended:
            raise MotionProtocolError('source_capacity', 'No facts after source end')
        count_frames = self.frames + (kind == 1)
        count_events = self.events + (kind == 2)
        if (count_frames > self.limits['source_frames'] or count_events > self.limits['source_events']
                or self.retained_bytes + len(payload) > self.limits['source_bytes']):
            raise MotionProtocolError('source_capacity', 'Selected source retention exhausted')
        self.frames = count_frames; self.events = count_events
        self.retained_bytes += len(payload)
        self.peak_retained_bytes = max(self.peak_retained_bytes, self.retained_bytes)
        self.facts.append((kind, payload, sequence, event_sequence, time.monotonic(), immediate))
        if kind == 3:
            self.ending = True
        self.wake.set()

    def capture(self, frame, sequence, immediate=False):
        if sequence != self.selected_sequence + 1:
            raise MotionProtocolError('sequence_gap', 'Selected source sequence is not consecutive')
        self.offer(1, frame, sequence, self.event_sequence, immediate)
        self.selected_sequence = sequence

    def lifecycle(self, request, sequence, sim_time_ns):
        event_sequence = self.event_sequence + 1
        value = {'source_event_sequence': str(event_sequence), 'event_id': str(uuid.uuid4()),
                 'event_type': 'lifecycle.applied', 'subject': {'session_id': self.scope['session_id']},
                 'sim_time_ns': str(sim_time_ns), 'observed_at': None,
                 'event': {**{name: request[name] for name in ('transition_id', 'revision', 'action')},
                           'boundary_source_sequence': str(sequence)}}
        payload = canonical(value)
        parse_source_event(payload.decode('utf-8'))
        self.offer(2, payload, sequence, event_sequence, True)
        self.event_sequence = event_sequence

    def end(self, request, sim_time_ns):
        value = {**{name: request[name] for name in ('transition_id', 'revision')}, 'reason': 'stop',
                 'last_source_sequence': str(self.selected_sequence), 'last_source_event_sequence': str(self.event_sequence),
                 'sim_time_ns': str(sim_time_ns)}
        payload = canonical(value)
        parse_source_end(payload.decode('utf-8'))
        self.offer(3, payload, self.selected_sequence, self.event_sequence, True)

    def transport_bytes(self):
        size = self.websocket.transport.get_write_buffer_size()
        self.peak_transport_bytes = max(self.peak_transport_bytes, size)
        if size > 65536:
            raise MotionProtocolError('source_capacity', 'Recording transport buffer exceeded')
        return size

    async def send(self, packet):
        self.transport_bytes()
        await self.websocket.send(packet)
        # One max-64-KiB write after a <=64-KiB check bounds queued serialized bytes at 128 KiB.
        if self.websocket.transport.get_write_buffer_size() > 131072:
            raise MotionProtocolError('source_capacity', 'Recording transport buffer exceeded')

    def next_packet(self):
        first = self.facts[0]
        kind = first[0]
        selected = [first]
        if kind == 1:
            frame_bytes = len(first[1])
            count = min(self.limits['frame_batch_frames'], (self.limits['packet_bytes'] - 112) // frame_bytes)
            for fact in list(self.facts)[1:count]:
                if fact[0] != 1:
                    break
                selected.append(fact)
            payload_bytes = 16 + len(selected) * frame_bytes
        else:
            payload_bytes = len(first[1])
        # Reserve all transient assembly/hash copies before allocating the payload/packet.
        reservation = 4 * (96 + payload_bytes)
        if self.retained_bytes + reservation > self.limits['source_bytes']:
            raise MotionProtocolError('source_capacity', 'Recording packet assembly exceeds retention')
        self.retained_bytes += reservation
        self.peak_retained_bytes = max(self.peak_retained_bytes, self.retained_bytes)
        try:
            payload = encode_frame_batch([fact[1] for fact in selected]) if kind == 1 else first[1]
            packet = encode_packet(self.scope, self.packet_sequence + 1, kind, payload)
        except BaseException:
            self.retained_bytes -= reservation
            raise
        packet_digest = 'sha256:' + packet[64:96].hex()
        last = selected[-1]
        expected = {'type': 'recording.ack', 'version': 1,
                    **{name: self.scope[name] for name in ('recording_id', 'session_id', 'lease_id', 'epoch')},
                    'source_packet_sequence': str(self.packet_sequence + 1), 'packet_sha256': packet_digest,
                    'source_prefix_sha256': advance_prefix(self.prefix, packet_digest),
                    'durable_source_sequence': str(last[2]), 'durable_source_event_sequence': str(last[3]),
                    'source_ended': kind == 3}
        return packet, expected, selected, reservation

    async def write(self):
        while True:
            await self.wake.wait()
            if not self.facts:
                self.wake.clear()
                continue
            if not any(fact[5] for fact in self.facts):
                # Batch ordinary samples, with the oldest retained age still watched independently.
                await asyncio.sleep(self.limits['sync_flush_ms'] / 1000)
            packet, expected, selected, reservation = self.next_packet()
            confirmation = asyncio.get_running_loop().create_future()
            self.inflight = (packet, expected, confirmation)
            oldest = selected[0][4]
            try:
                await self.send(packet)
                retry_times = (self.limits['retry_first_ms'] / 1000,
                               self.limits['retry_second_ms'] / 1000, self.deadline_seconds)
                for index, delay in enumerate(retry_times):
                    remaining = oldest + delay - time.monotonic()
                    try:
                        await asyncio.wait_for(asyncio.shield(confirmation), timeout=max(0, remaining))
                        break
                    except asyncio.TimeoutError:
                        if index == len(retry_times) - 1:
                            raise MotionProtocolError('ack_timeout', 'Recording durable ACK deadline exceeded')
                        await self.send(packet)
                        self.retries += 1
                self.last_ack = expected
                self.prefix = expected['source_prefix_sha256']
                self.packet_sequence += 1
                self.durable_sequence = int(expected['durable_source_sequence'])
                self.durable_event_sequence = int(expected['durable_source_event_sequence'])
                self.ended = expected['source_ended']
                for fact in selected:
                    if self.facts.popleft() is not fact:
                        raise RuntimeError('Reliable collector ownership changed')
                    self.retained_bytes -= len(fact[1]); self.frames -= fact[0] == 1; self.events -= fact[0] == 2
                self.changed.set()
            finally:
                self.inflight = None
                self.retained_bytes -= reservation
                if not confirmation.done():
                    confirmation.cancel()
            if not self.facts:
                self.wake.clear()
            if self.ended:
                await asyncio.Future()  # Normal source-end ownership lasts until the live Stop ACK is sent.

    async def read(self):
        async for message in self.websocket:
            receipt = parse_ack(message)
            if self.last_ack is not None and receipt == self.last_ack:
                continue
            if self.inflight is None or receipt != self.inflight[1]:
                raise MotionProtocolError('invalid_ack', 'Recording ACK outside exact in-flight receipt')
            if not self.inflight[2].done():
                self.inflight[2].set_result(None)
        # A close after a verified terminal ACK is harmless while live Stop completes.
        if self.ended or (self.inflight and self.inflight[1]['source_ended'] and self.inflight[2].done()):
            await asyncio.Future()
        raise MotionProtocolError('source_disconnected', 'Recording connection closed before source end')

    async def watchdog(self):
        while True:
            await asyncio.sleep(min(0.05, self.deadline_seconds / 4))
            self.transport_bytes()
            if self.facts and time.monotonic() - self.facts[0][4] >= self.deadline_seconds:
                raise MotionProtocolError('ack_timeout', 'Oldest retained source fact deadline exceeded')

    async def drain(self, deadline, ended=False):
        target_sequence, target_events = self.selected_sequence, self.event_sequence
        while (self.durable_sequence < target_sequence or self.durable_event_sequence < target_events
               or (ended and not self.ended)):
            self.changed.clear()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MotionProtocolError('ack_timeout', 'Total Recording transition drain exceeded')
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                raise MotionProtocolError('ack_timeout', 'Total Recording transition drain exceeded') from None

    def report(self):
        return {'durable_source_sequence': self.durable_sequence, 'durable_source_event_sequence': self.durable_event_sequence,
                'last_verified_packet_sequence': self.packet_sequence, 'source_prefix_sha256': self.prefix,
                'source_ended': self.ended, 'recording_retries': self.retries,
                'recording_peak_retained_bytes': self.peak_retained_bytes,
                'recording_peak_transport_bytes': self.peak_transport_bytes}

    def clear(self):
        self.facts.clear(); self.retained_bytes = 0; self.frames = 0; self.events = 0
        self.wake.clear(); self.changed.clear()


async def admit_recording(websocket, bootstrap, welcome):
    header = implementation_header()
    hello = {'type': 'recording.hello', 'version': 1, 'codec': CODEC, **identity(bootstrap),
             'ticket': bootstrap['ticket'], 'source_header': header}
    encoded = canonical(hello).decode('utf-8')
    if len(encoded.encode('utf-8')) > bootstrap['limits']['hello_bytes']:
        raise MotionProtocolError('source_capacity', 'Recording HELLO exceeds admitted budget')
    await websocket.send(encoded)
    ready = verify_ready(await asyncio.wait_for(websocket.recv(), 3), bootstrap, header, welcome)
    return ReliableRecording(websocket, bootstrap, ready)
