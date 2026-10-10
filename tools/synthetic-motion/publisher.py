"""Outbound Synthetic Publisher. Install optional requirements.txt to run it."""

import argparse
import asyncio
import ipaddress
import json
import math
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from motion_codec import CODEC, MAX_CONTROL_BYTES, MotionProtocolError, encode_snapshot, parse_u64, parse_welcome
from synthetic import JOINT_KEYS, POSE_KEYS, RATE_HZ, synthetic_snapshot


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
    parser.add_argument('--url', required=True, help='Gateway Publisher endpoint; WS only on loopback')
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--scene-hash', required=True)
    parser.add_argument('--duration', type=float, default=600)
    ticket_group = parser.add_mutually_exclusive_group()
    ticket_group.add_argument('--ticket-stdin', action='store_true', help='Read scoped ticket from stdin')
    ticket_group.add_argument('--ticket-file', type=Path, help='Read scoped ticket from an owned file')
    args = parser.parse_args()
    if args.ticket_stdin:
        ticket = sys.stdin.readline(513).strip()
    elif args.ticket_file:
        with args.ticket_file.open() as stream:
            ticket = stream.readline(513).strip()
    else:
        ticket = os.environ.get('MOTION_PUBLISHER_TICKET', '')
    if not ticket or len(ticket) > 512:
        parser.error('Provide a scoped ticket via stdin, file or MOTION_PUBLISHER_TICKET')
    try:
        result = asyncio.run(publish(args.url, ticket, args.session_id, args.scene_hash, args.duration))
        print(json.dumps(result, separators=(',', ':')))
    except KeyboardInterrupt:
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
