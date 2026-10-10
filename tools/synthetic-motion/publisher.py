"""Outbound Synthetic Publisher. Install optional requirements.txt to run it."""

import argparse
import asyncio
import ipaddress
import json
import math
import os
import signal
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from motion_codec import (CODEC, MAX_CONTROL_BYTES, MotionProtocolError, control_json,
                          encode_snapshot, parse_session_control, parse_u64, parse_welcome)
from synthetic import (JOINT_KEYS, POSE_KEYS, RATE_HZ, configured_snapshot,
                       parse_startup, synthetic_snapshot)


def transport_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme not in ('ws', 'wss') or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError('Use a WS/WSS endpoint without credentials or query parameters')
    if parsed.scheme == 'ws':
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            loopback = parsed.hostname.lower() == 'localhost'
        if not loopback:
            raise ValueError('Unencrypted WS is limited to loopback; use WSS elsewhere')
    return url


class LatestSnapshot:
    """One pending application snapshot, independently sampled and sent."""

    def __init__(self):
        self.value = None
        self.ready = asyncio.Event()
        self.sampled = 0
        self.sent = 0
        self.overwritten = 0

    def offer(self, value):
        if self.value is not None:
            self.overwritten += 1
        self.value = value
        self.sampled += 1
        self.ready.set()

    async def take(self):
        await self.ready.wait()
        result = self.value
        self.value = None
        self.ready.clear()
        return result


class SimulationClock:
    """Simulation nanoseconds advance only while running, independently of sequence."""

    def __init__(self, now=time.monotonic_ns):
        self.now = now
        self.elapsed = 0
        self.anchor = None

    def read(self):
        return self.elapsed if self.anchor is None else self.elapsed + self.now() - self.anchor

    def pause(self):
        self.elapsed = self.read()
        self.anchor = None

    def resume(self):
        if self.anchor is None:
            self.anchor = self.now()


class SessionOutbox(LatestSnapshot):
    """One replaceable live frame plus one reliable ordered frame/ACK boundary."""

    def __init__(self):
        super().__init__()
        self.boundary = None

    def offer_boundary(self, frame, ack):
        if self.boundary is not None:
            raise MotionProtocolError('invalid_message', 'Session transition already in flight')
        if self.value is not None:
            self.overwritten += 1
        self.value = None
        completed = asyncio.get_running_loop().create_future()
        self.boundary = (frame, ack, completed)
        self.sampled += 1
        self.ready.set()
        return completed

    async def take_message(self):
        await self.ready.wait()
        if self.boundary is not None:
            result = self.boundary
            self.boundary = None
        else:
            result = (self.value, None, None)
            self.value = None
        self.ready.clear()
        return result


async def publish_session(startup, duration=None):
    """A single admitted Session, with no reconnect or automatic lifecycle replay."""
    from websockets.asyncio.client import connect

    url = transport_url(startup.url)
    if duration is not None and (not math.isfinite(duration) or duration <= 0):
        raise ValueError('Duration must be positive and finite')
    outbox = SessionOutbox()
    clock = SimulationClock()
    running = asyncio.Event()
    tasks = []
    sequence = 0
    last_revision = -1
    async with connect(url, open_timeout=3, close_timeout=3, ping_interval=20,
                       ping_timeout=20, max_size=MAX_CONTROL_BYTES, max_queue=1,
                       write_limit=64 * 1024, compression=None, proxy=None) as websocket:
        hello = {'type': 'motion.hello', 'version': 1, 'role': 'publisher',
                 'session_id': startup.session_id, 'scene_hash': startup.scene_hash,
                 'codec': CODEC, 'ticket': startup.ticket, 'preferred_rate_hz': RATE_HZ}
        await websocket.send(json.dumps(hello, separators=(',', ':')))
        welcome = parse_welcome(await asyncio.wait_for(websocket.recv(), timeout=3))
        if (welcome['session_id'] != startup.session_id or welcome['scene_hash'] != startup.scene_hash
                or welcome['pose_keys'] != list(startup.body_order)
                or welcome['joint_keys'] != list(startup.joint_order) or welcome['rate_hz'] != RATE_HZ):
            raise MotionProtocolError('mapping_mismatch', 'Synthetic startup does not match admission')
        epoch = parse_u64(welcome['epoch'])

        def frame():
            nonlocal sequence
            sequence += 1
            snapshot = configured_snapshot(startup, epoch, sequence, clock.read(), welcome['mapping_revision'])
            return snapshot, encode_snapshot(snapshot)

        # Admission readiness is an actual full t=0 source frame, not a status claim.
        _, initial = frame()
        await websocket.send(initial)
        outbox.sampled += 1
        outbox.sent += 1
        clock.resume()
        running.set()

        async def sample():
            deadline = time.monotonic() + 1 / RATE_HZ
            while True:
                await running.wait()
                await asyncio.sleep(max(0, deadline - time.monotonic()))
                if running.is_set():
                    _, value = frame()
                    outbox.offer(value)
                # Skip missed deadlines; never catch up paused wall time or burst frames.
                deadline = time.monotonic() + 1 / RATE_HZ

        async def write():
            while True:
                value, ack, completed = await outbox.take_message()
                try:
                    await websocket.send(value)
                    outbox.sent += 1
                    if ack is not None:
                        await websocket.send(ack)
                        completed.set_result(None)
                except BaseException as error:
                    if completed is not None and not completed.done():
                        completed.set_exception(error)
                    raise

        async def control():
            nonlocal last_revision
            async for message in websocket:
                value = control_json(message)
                if value.get('type') == 'motion.status':
                    if value.get('state') not in ('waiting', 'live', 'stale', 'paused'):
                        raise MotionProtocolError('session_closed', 'Gateway ended Session')
                    continue
                request = parse_session_control(message)
                if (request['session_id'] != startup.session_id or request['epoch'] != welcome['epoch']
                        or request['revision'] <= last_revision):
                    raise MotionProtocolError('unauthorized', 'Session control scope or revision rejected')
                action = request['action']
                if (action == 'pause' and not running.is_set()) or (action == 'resume' and running.is_set()):
                    raise MotionProtocolError('invalid_message', 'Session action conflicts with source state')
                running.clear()
                clock.pause()
                snapshot, boundary = frame()
                ack = {'type': 'motion.session_ack',
                       **{name: request[name] for name in ('session_id', 'epoch', 'transition_id', 'revision', 'action')},
                       'result': 'applied', 'last_sequence': str(snapshot['sequence']),
                       'sim_time_ns': str(snapshot['sim_time_ns'])}
                await outbox.offer_boundary(boundary, json.dumps(ack, separators=(',', ':')))
                last_revision = request['revision']
                if action == 'stop':
                    return
                if action == 'resume':
                    clock.resume()
                    running.set()
            raise MotionProtocolError('session_closed', 'Gateway closed Session connection')

        tasks = [asyncio.create_task(sample()), asyncio.create_task(write()), asyncio.create_task(control())]
        if duration is not None:
            tasks.append(asyncio.create_task(asyncio.sleep(duration)))
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            outbox.value = None
            if outbox.boundary is not None:
                outbox.boundary[2].cancel()
            outbox.boundary = None
            outbox.ready.clear()
    return {'sampled': outbox.sampled, 'sent': outbox.sent, 'overwritten': outbox.overwritten}


async def run_owned(operation, watch_stdin=False):
    """SIGTERM/parent-pipe EOF cancel the owner, including before admission."""
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    previous = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGTERM, lambda *_: loop.call_soon_threadsafe(task.cancel))

    if watch_stdin:
        def parent_pipe():
            # A daemon avoids a blocking executor join after a normal source Stop.
            # os.read does not hold a buffered stdin lock during interpreter exit.
            try:
                os.read(sys.stdin.fileno(), 1)
                loop.call_soon_threadsafe(task.cancel)
            except (OSError, RuntimeError):
                pass

        threading.Thread(target=parent_pipe, name='session-parent-pipe', daemon=True).start()
    try:
        return await operation
    finally:
        signal.signal(signal.SIGTERM, previous)


def arm_parent_guard():
    """Linux SIGKILL still releases a stopped source when its owning Node dies."""
    if sys.platform != 'linux':
        return
    import ctypes

    expected_parent = int(os.environ['LAB_WORD_SYNTHETIC_PARENT_PID'])
    if (expected_parent <= 0
            or ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0
            or os.getppid() != expected_parent):
        raise RuntimeError('Synthetic source parent guard unavailable')


async def publish(url, ticket, session_id, scene_hash, duration):
    # The dependency is optional: stdlib codec/oracle invocation never imports it.
    from websockets.asyncio.client import connect

    url = transport_url(url)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Duration must be positive and finite')
    slot = LatestSnapshot()
    tasks = []
    started = time.monotonic()
    async with connect(url, open_timeout=3, close_timeout=3, ping_interval=20,
                       ping_timeout=20, max_size=MAX_CONTROL_BYTES, max_queue=1,
                       write_limit=64 * 1024, compression=None, proxy=None) as websocket:
        hello = {'type': 'motion.hello', 'version': 1, 'role': 'publisher',
                 'session_id': session_id, 'scene_hash': scene_hash, 'codec': CODEC,
                 'ticket': ticket, 'preferred_rate_hz': RATE_HZ}
        await websocket.send(json.dumps(hello, separators=(',', ':')))
        admitted = await asyncio.wait_for(websocket.recv(), timeout=3)
        welcome = parse_welcome(admitted)
        if (welcome['session_id'] != session_id or welcome['scene_hash'] != scene_hash
                or welcome['pose_keys'] != POSE_KEYS or welcome['joint_keys'] != JOINT_KEYS
                or welcome['rate_hz'] != RATE_HZ):
            raise MotionProtocolError('mapping_mismatch', 'Synthetic source does not match fixture admission')
        epoch = parse_u64(welcome['epoch'])
        anchor = time.monotonic()

        async def sample():
            index = 0
            while True:
                deadline = anchor + index / RATE_HZ
                await asyncio.sleep(max(0, deadline - time.monotonic()))
                # Skip missed deadlines rather than emitting a catch-up burst.
                index = max(index, int((time.monotonic() - anchor) * RATE_HZ))
                snapshot = synthetic_snapshot(epoch, index + 1,
                                              index * 1_000_000_000 // RATE_HZ,
                                              welcome['mapping_revision'])
                slot.offer(encode_snapshot(snapshot))
                index += 1

        async def write():
            while True:
                await websocket.send(await slot.take())
                slot.sent += 1

        async def control():
            async for message in websocket:
                if not isinstance(message, str):
                    raise MotionProtocolError('invalid_message', 'Publisher expects JSON control only')
                from motion_codec import control_json
                value = control_json(message)
                if value.get('type') == 'motion.error':
                    # Do not echo untrusted server messages or credentials to logs.
                    raise MotionProtocolError('session_closed', 'Gateway rejected Publisher stream')
                if value.get('type') != 'motion.status' or value.get('state') not in ('waiting', 'live', 'stale'):
                    raise MotionProtocolError('session_closed', 'Gateway ended Publisher stream')
            raise MotionProtocolError('session_closed', 'Gateway closed Publisher connection')

        tasks = [asyncio.create_task(sample()), asyncio.create_task(write()),
                 asyncio.create_task(control()), asyncio.create_task(asyncio.sleep(duration))]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            slot.value = None
            slot.ready.clear()
    return {'sampled': slot.sampled, 'sent': slot.sent, 'overwritten': slot.overwritten,
            'elapsed_seconds': round(time.monotonic() - started, 3), 'frame_bytes': 632}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', help='Gateway Publisher endpoint; WS only on loopback')
    parser.add_argument('--session-id')
    parser.add_argument('--scene-hash')
    parser.add_argument('--startup-stdin', action='store_true', help='Read frozen Session startup JSON from owned stdin')
    parser.add_argument('--duration', type=float, default=600)
    ticket_group = parser.add_mutually_exclusive_group()
    ticket_group.add_argument('--ticket-stdin', action='store_true', help='Read scoped ticket from stdin')
    ticket_group.add_argument('--ticket-file', type=Path, help='Read scoped ticket from an owned file')
    args = parser.parse_args()
    if args.startup_stdin:
        if args.url or args.session_id or args.scene_hash or args.ticket_stdin or args.ticket_file:
            parser.error('Session startup must come entirely from stdin')
    elif not args.url or not args.session_id or not args.scene_hash:
        parser.error('Legacy fixture requires --url, --session-id and --scene-hash')
    if args.ticket_stdin:
        ticket = sys.stdin.readline(513).strip()
    elif args.ticket_file:
        with args.ticket_file.open() as stream:
            ticket = stream.readline(513).strip()
    else:
        ticket = os.environ.get('MOTION_PUBLISHER_TICKET', '')
    if not args.startup_stdin and (not ticket or len(ticket) > 512):
        parser.error('Provide a scoped ticket via stdin, file or MOTION_PUBLISHER_TICKET')
    try:
        if args.startup_stdin:
            arm_parent_guard()
            startup = parse_startup(sys.stdin.readline(MAX_CONTROL_BYTES + 1))
            operation = publish_session(startup)
        else:
            operation = publish(args.url, ticket, args.session_id, args.scene_hash, args.duration)
        result = asyncio.run(run_owned(operation, watch_stdin=args.startup_stdin))
        print(json.dumps(result, separators=(',', ':')))
    except KeyboardInterrupt:
        return 130
    except asyncio.CancelledError:
        return 130
    except ImportError:
        print('Install tools/synthetic-motion/requirements.txt in an isolated Python environment.', file=sys.stderr)
        return 1
    except Exception as error:
        # Exception text from a transport may include connection details; print only a safe class/code.
        print(f'Publisher stopped: {getattr(error, "code", type(error).__name__)}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
