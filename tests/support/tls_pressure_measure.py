"""Owned passive TLS pressure facts. Never changes a transport or queue limit."""
import json
import os
from pathlib import Path
import socket
import struct
import time
import asyncio
import sys


def available(read):
    try:
        value = read()
        return {'available': True, 'value': value}
    except (AttributeError, OSError, TypeError, ValueError) as error:
        return {'available': False, 'reason': type(error).__name__}


class ObservationHealth:
    def __init__(self, role, session):
        self.role, self.session = role, session
        self.failed = False
        self.published = 0
        self.last_tuple_ms = None

    def status(self, final=False):
        return {'valid': not self.failed, 'category': 'pressure_observer_failed' if self.failed else None,
                'published': self.published, 'lastTupleWallMs': self.last_tuple_ms, 'final': final}

    def receipt(self, final=False):
        try:
            root = Path(os.environ['SECURE_MOTION_SOURCE_WITNESS'])
            path = root / (self.role + '-' + self.session + '.pressure-health.json')
            temporary = path.with_suffix('.next')
            with temporary.open('w', opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
                handle.write(json.dumps(self.status(final)) + '\n')
            temporary.replace(path)
        except Exception:
            self.invalidate()

    def invalidate(self):
        first = not self.failed
        self.failed = True
        if first:
            try:
                print(json.dumps({'event': 'pressure.observer.invalid', 'role': self.role,
                                  'diagnosticHealth': self.status()}), file=sys.stderr, flush=True)
            except Exception:
                pass

    def observe(self, operation):
        if self.failed:
            return None
        try:
            return operation()
        except Exception:
            self.invalidate()
            self.receipt()
            return None

    def success(self):
        self.published += 1
        self.last_tuple_ms = time.time_ns() // 1_000_000
        self.receipt()


health_owners = {}
def observation_health(role, session):
    key = (role, session)
    if key not in health_owners:
        health_owners[key] = ObservationHealth(role, session)
    return health_owners[key]


class Facts:
    def __init__(self, session, role):
        self.health = observation_health(role, session)
        self.directory = Path(os.environ['TLS_PRESSURE_PROBE_DIR'])
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.session = session
        self.role = role
        self.samples = 0
        self.started = None
        self.previous = 0
        self.observation_ns = 0
        self.failure = None

    def save(self, values):
        if self.failure is not None:
            return
        now = time.monotonic_ns()
        if now - self.previous < 1_000_000_000 or self.samples >= 181:
            return
        self.previous = now
        try:
            window = json.loads((self.directory / 'window.json').read_text())
        except (OSError, ValueError):
            return
        if window.get('sessionId') != self.session:
            return
        self.started = now if self.started is None else self.started
        if now - self.started > 180_000_000_000:
            return
        begin = time.monotonic_ns()
        self.samples += 1
        row = {'role': self.role, 'pid': os.getpid(), 'sample': self.samples,
               'clock': 'Python time.monotonic_ns; subtract only this clock',
               'monoNs': str(now), 'wallNs': str(time.time_ns()),
               'windowFirstObservedMonoNs': str(self.started),
               'priorObservationNs': str(self.observation_ns), 'diagnosticHealth': self.health.status(), **values}
        data = json.dumps(row, separators=(',', ':')) + '\n'
        if len(data.encode()) > 8192:
            raise RuntimeError('Owned pressure tuple exceeded bound')
        path = self.directory / (self.role + '-' + self.session + '.json')
        temporary = path.with_suffix('.next')
        with temporary.open('w', opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
            handle.write(data)
        temporary.replace(path)
        journal = self.directory / (self.role + '-' + self.session + '.jsonl')
        if journal.exists() and journal.stat().st_size + len(data.encode()) > 2 * 1024 * 1024:
            raise RuntimeError('Owned pressure journal exceeded bound')
        with journal.open('a', opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
            handle.write(data)
        self.observation_ns += time.monotonic_ns() - begin
        self.health.success()

    def observe(self, values):
        self.health.observe(lambda: self.save(values))


class SourceFacts(Facts):
    def __init__(self, session):
        super().__init__(session, 'source')
        self.selected = 0
        self.attempts = 0
        self.unique = 0
        self.last_packet = None
        self.last_sequence = None
        self.first_selected_ns = None
        self.last_selected_ns = None
        self.first_sim_ns = None
        self.last_sim_ns = None

    def capture(self, frame, sequence):
        now = time.monotonic_ns()
        self.selected += 1
        self.last_sequence = str(sequence)
        self.first_selected_ns = now if self.first_selected_ns is None else self.first_selected_ns
        self.last_selected_ns = now
        sim = struct.unpack_from('<Q', frame, 24)[0]
        self.first_sim_ns = sim if self.first_sim_ns is None else self.first_sim_ns
        self.last_sim_ns = sim
        self.snapshot()

    def packet(self, packet):
        self.attempts += 1
        sequence = struct.unpack_from('<Q', packet, 48)[0]
        if sequence != self.last_packet:
            self.unique += 1
        self.last_packet = sequence
        self.snapshot()

    def snapshot(self):
        self.observe({'selectionAttempts': self.selected, 'packetSendAttempts': self.attempts,
                   'uniquePacketSequences': self.unique, 'lastSourceSequence': self.last_sequence,
                   'lastPacketSequence': None if self.last_packet is None else str(self.last_packet),
                   'firstSelectedMonoNs': None if self.first_selected_ns is None else str(self.first_selected_ns),
                   'lastSelectedMonoNs': None if self.last_selected_ns is None else str(self.last_selected_ns),
                   'firstSimTimeNs': None if self.first_sim_ns is None else str(self.first_sim_ns),
                   'lastSimTimeNs': None if self.last_sim_ns is None else str(self.last_sim_ns)})


class PeerFacts(Facts):
    def __init__(self, session, ws, peer, local, remote):
        super().__init__(session, 'peer')
        self.ws, self.peer = ws, peer
        self.local, self.remote = local, remote

    def tcp_info(self):
        data = self.peer.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 256)
        if len(data) < 24:
            raise ValueError('TCP_INFO layout unavailable')
        # Linux UAPI tcp_info: scale nibbles at6, snd/rcv MSS at16/20.
        return {'bytes': len(data), 'layout': 'Linux tcp_info initial24bytes',
                'sndWindowScale': data[6] & 15, 'rcvWindowScale': data[6] >> 4,
                'sndMss': struct.unpack_from('=I', data, 16)[0],
                'rcvMss': struct.unpack_from('=I', data, 20)[0]}

    async def observe(self):
        while True:
            transport = self.ws.transport
            protocol = getattr(transport, '_ssl_protocol', None)
            super().observe({'localAddress': self.local[0], 'localPort': self.local[1],
                       'remoteAddress': self.remote[0], 'remotePort': self.remote[1],
                       'recvBufferBytes': available(lambda: self.peer.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)),
                       'sendBufferBytes': available(lambda: self.peer.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF)),
                       'tcpInfo': available(self.tcp_info),
                       'tcpMaxSegment': available(lambda: self.peer.getsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG)),
                       'tlsAppReading': available(lambda: transport.is_reading()),
                       'tlsReadBufferBytes': available(lambda: transport.get_read_buffer_size()),
                       'tlsReadBufferLimits': available(lambda: transport.get_read_buffer_limits()),
                       'rawTcpReading': available(lambda: protocol._transport.is_reading()),
                       'tlsIncomingPendingBytes': available(lambda: protocol._incoming.pending),
                       'sslDecryptedPendingBytes': available(lambda: protocol._sslobj.pending()),
                       'websocketQueuedFrames': available(lambda: len(self.ws.recv_messages.frames)),
                       'websocketAssemblerPaused': available(lambda: self.ws.recv_messages.paused)})
            await asyncio.sleep(1)


def watch_peer_task(task, health):
    def completed(owner):
        try:
            if not owner.cancelled() and owner.exception() is not None:
                health.invalidate()
                health.receipt()
        except Exception:
            health.invalidate()
    task.add_done_callback(completed)
    return task
