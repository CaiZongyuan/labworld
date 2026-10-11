"""Startup/clock checks and optional real subprocess + ordered WS lifecycle checks."""

import asyncio
import dataclasses
import importlib.util
import json
import math
import os
import signal
import struct
import sys
import time
import unittest
from pathlib import Path

from motion_codec import MotionProtocolError, decode_snapshot, parse_session_ack
from publisher import SessionOutbox, SimulationClock
from synthetic import configured_snapshot, parse_startup
from recording_codec import (advance_prefix, canonical_source_header, decode_packet, limits, mapping_digest,
                             policy, sha256, source_prefix_seed, CAPTURE_POLICY)

SESSION_ID = '12345678-1234-1234-1234-123456789abc'
TRANSITION_ID = '12345678-1234-1234-1234-123456789def'
EPOCH = '9007199254740993'


def startup_value():
    return {'version': 1, 'url': 'ws://127.0.0.1:1/publisher', 'ticket': 'a' * 32,
            'session_id': SESSION_ID, 'scene_hash': 'sha256:' + 'a' * 64,
            'body_order': ['saved/body'], 'joint_order': ['saved/joint'],
            'initial_poses': [{'position': [-4, 2, 8],
                               'quaternion': [0, 0, math.sqrt(0.5), math.sqrt(0.5)]}],
            'initial_joints': [0.25],
            'parameters': {'translation_amplitude': 0.6, 'angular_speed': 0.4, 'joint_amplitude': 0.5}}


class StartupClockTests(unittest.TestCase):
    def test_parameter_bounds_preserve_every_initial_body_and_joint_at_t0(self):
        for amplitude, speed, joint_amplitude in ((0, 0, 0), (10, 10, 10), (0.45, 1, 1)):
            value = startup_value()
            value['body_order'] = [f'saved/body/{index}' for index in range(20)]
            value['joint_order'] = [f'saved/joint/{index}' for index in range(6)]
            value['initial_poses'] = [{'position': [index * 2, 1, -index],
                                      'quaternion': [0, 0, math.sqrt(0.5), math.sqrt(0.5)]}
                                     for index in range(20)]
            value['initial_joints'] = [index / 10 for index in range(6)]
            value['parameters'] = {'translation_amplitude': amplitude, 'angular_speed': speed,
                                   'joint_amplitude': joint_amplitude}
            initial = configured_snapshot(parse_startup(json.dumps(value)), 3, 1, 0, 7)
            self.assertEqual(initial['poses'], value['initial_poses'])
            self.assertEqual(initial['joints'], value['initial_joints'])

    def test_saved_initial_state_is_exact_immutable_and_controls_later_trajectory(self):
        value = startup_value()
        startup = parse_startup(json.dumps(value))
        value['initial_poses'][0]['position'][0] = 999
        with self.assertRaises(dataclasses.FrozenInstanceError):
            startup.angular_speed = 99
        with self.assertRaises(TypeError):
            startup.initial_poses[0][0][0] = 999
        initial = configured_snapshot(startup, 3, 1, 0, 7)
        self.assertEqual(initial['poses'][0], startup_value()['initial_poses'][0])
        self.assertEqual(initial['joints'], [0.25])
        later = configured_snapshot(startup, 3, 91, 1_000_000_000, 7)
        self.assertAlmostEqual(later['poses'][0]['position'][0], -4 + 0.6 * math.sin(1))
        self.assertAlmostEqual(later['poses'][0]['position'][2], 8 + 0.6 * (math.cos(1) - 1))
        self.assertAlmostEqual(later['joints'][0], 0.25 + 0.5 * math.sin(1))
        self.assertEqual(later['sequence'], 91)

    def test_startup_rejects_ambiguous_mapping_nonfinite_parameters_and_invalid_pose(self):
        for patch in ({'body_order': ['x', 'x']}, {'joint_order': []}, {'version': True},
                      {'initial_poses': [{'position': [0, 0, 0], 'quaternion': [0, 0, 0, 0.5]}]},
                      {'parameters': {'translation_amplitude': -1, 'angular_speed': 1, 'joint_amplitude': 1}},
                      {'parameters': {'translation_amplitude': '1', 'angular_speed': 1, 'joint_amplitude': 1}},
                      {'parameters': {'translation_amplitude': 11, 'angular_speed': 1, 'joint_amplitude': 1}}):
            with self.subTest(patch=patch), self.assertRaises(MotionProtocolError):
                parse_startup(json.dumps({**startup_value(), **patch}))
        with self.assertRaises(MotionProtocolError):
            parse_startup(json.dumps(startup_value()).replace('0.6', 'NaN'))

    def test_clock_excludes_pause_duration_without_resetting_time(self):
        now = [100]
        clock = SimulationClock(lambda: now[0])
        self.assertEqual(clock.read(), 0)
        clock.resume()
        now[0] += 50
        clock.pause()
        now[0] += 10_000
        self.assertEqual(clock.read(), 50)
        clock.resume()
        now[0] += 25
        self.assertEqual(clock.read(), 75)


class OutboxTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_live_writer_cannot_replace_or_overtake_boundary_ack(self):
        outbox = SessionOutbox()
        outbox.offer(b'first-in-flight')
        first = await outbox.take_message()
        for index in range(1000):
            outbox.offer(str(index).encode())
        completed = outbox.offer_boundary(b'final-boundary', 'correlated-ack')
        self.assertEqual(first, (b'first-in-flight', None, None))
        self.assertEqual(await outbox.take_message(), (b'final-boundary', 'correlated-ack', completed))
        self.assertIsNone(outbox.value)
        self.assertEqual(outbox.overwritten, 1000)
        self.assertFalse(completed.done())
        completed.set_result(None)
        await completed


def ledger(event, **resource):
    """No credentials/input snapshots are written to the optional owned-resource ledger."""
    path = os.environ.get('SYNTHETIC_TEST_LEDGER')
    if path:
        with Path(path).open('a') as stream:
            stream.write(json.dumps({'at_ns': time.time_ns(), 'owner': 'recording-72-source-check',
                                     'event': event, **resource}) + '\n')


@unittest.skipUnless(importlib.util.find_spec('websockets'), 'optional pinned WebSocket dependency unavailable')
class SourceSocketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from websockets.asyncio.server import serve

        self.connection = asyncio.get_running_loop().create_future()
        self.shutdown = asyncio.Event()
        self.connections = 0
        self.process = None
        self.recorded_frames = []
        self.recorded_events = []
        self.source_end = None
        self.alter_recording_ack = False
        self.recording_socket = None
        self.recording_bootstrap = {'recording_id': '12345678-1234-1234-1234-123456789001',
            'session_id': SESSION_ID, 'lease_id': '12345678-1234-1234-1234-123456789002', 'epoch': EPOCH,
            'snapshot_hash': 'sha256:' + 'b' * 64, 'manifest_sha256': 'sha256:' + 'c' * 64,
            'scene_hash': 'sha256:' + 'a' * 64, 'mapping_revision': 7,
            'mapping_sha256': mapping_digest(7, ['saved/body'], ['saved/joint']),
            'websocket_path': '/api/v1/lab/recordings/12345678-1234-1234-1234-123456789001/source',
            'ticket': 'b' * 32, 'expires_in_seconds': 30, 'capture_policy': policy(CAPTURE_POLICY), 'limits': limits()}

        async def handler(websocket):
            self.connections += 1
            if websocket.request.path == self.recording_bootstrap['websocket_path']:
                self.recording_socket = websocket
                ledger('acquired', kind='recording-source-socket', port=self.port, consumer=self.process.pid)
                hello = json.loads(await websocket.recv())
                header_digest = sha256(canonical_source_header(hello['source_header']))
                prefix = source_prefix_seed(self.recording_bootstrap, header_digest)
                ready = {'type': 'recording.ready', 'version': 1, 'codec': 'lwr1-source-v1',
                         **{name: self.recording_bootstrap[name] for name in ('recording_id', 'session_id', 'lease_id', 'epoch',
                             'snapshot_hash', 'manifest_sha256', 'scene_hash', 'mapping_revision', 'mapping_sha256')},
                         'source_header_sha256': header_digest, 'source_prefix_sha256': prefix,
                         'capture_policy': CAPTURE_POLICY, 'limits': limits()}
                await websocket.send(json.dumps(ready))
                sequence = 0
                last_ack = None
                try:
                    async for message in websocket:
                        packet = decode_packet(message, self.recording_bootstrap)
                        if packet['source_packet_sequence'] == sequence and last_ack is not None:
                            self.assertEqual(packet['packet_sha256'], last_ack['packet_sha256'])
                            await websocket.send(json.dumps(last_ack))
                            continue
                        self.assertEqual(packet['source_packet_sequence'], sequence + 1)
                        payload = packet['payload']
                        if packet['kind'] == 1:
                            first, count, size = struct.unpack_from('<QII', payload)
                            self.assertEqual(first, len(self.recorded_frames) + 1)
                            for index in range(count):
                                self.recorded_frames.append(bytes(payload[16 + index * size:16 + (index + 1) * size]))
                        elif packet['kind'] == 2:
                            self.recorded_events.append(json.loads(bytes(payload)))
                        else:
                            self.source_end = json.loads(bytes(payload))
                            self.assertEqual(self.source_end['reason'], 'stop')
                        prefix = advance_prefix(prefix, packet['packet_sha256'])
                        sequence += 1
                        last_ack = {'type': 'recording.ack', 'version': 1,
                                    **{name: ready[name] for name in ('recording_id', 'session_id', 'lease_id', 'epoch')},
                                    'source_packet_sequence': str(sequence), 'packet_sha256': packet['packet_sha256'],
                                    'source_prefix_sha256': prefix, 'durable_source_sequence': str(len(self.recorded_frames)),
                                    'durable_source_event_sequence': str(len(self.recorded_events)), 'source_ended': self.source_end is not None}
                        if self.alter_recording_ack:
                            last_ack['durable_source_sequence'] = str(len(self.recorded_frames) + 1)
                        await websocket.send(json.dumps(last_ack))
                except Exception as error:
                    from websockets.exceptions import ConnectionClosed
                    if not isinstance(error, ConnectionClosed):
                        raise
                ledger('released', kind='recording-source-socket', port=self.port, consumer=self.process.pid)
                return
            if not self.connection.done():
                self.connection.set_result(websocket)
            ledger('acquired', kind='motion-source-socket', port=self.port, consumer=self.process.pid)
            await self.shutdown.wait()
            ledger('released', kind='motion-source-socket', port=self.port, consumer=self.process.pid)

        self.server = await serve(handler, '127.0.0.1', 0, compression=None, ping_interval=0.1, ping_timeout=1)
        self.port = self.server.sockets[0].getsockname()[1]
        ledger('acquired', kind='loopback-ws-listener', port=self.port, consumer=os.getpid())
        try:
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, str(Path(__file__).with_name('publisher.py')), '--startup-stdin',
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env={**os.environ, 'LAB_WORD_SYNTHETIC_PARENT_PID': str(os.getpid())})
            ledger('acquired', kind='python-publisher', pid=self.process.pid, port=self.port)
            value = startup_value()
            value['url'] = f'ws://127.0.0.1:{self.port}/publisher'
            value['recording'] = self.recording_bootstrap
            self.process.stdin.write((json.dumps(value) + '\n').encode())
            await self.process.stdin.drain()
            self.websocket = await asyncio.wait_for(self.connection, 3)
            hello = json.loads(await asyncio.wait_for(self.websocket.recv(), 3))
            self.assertEqual(hello['session_id'], SESSION_ID)
            self.assertNotIn('epoch', hello)
            welcome = {'type': 'motion.welcome', 'version': 1, 'session_id': SESSION_ID,
                       'scene_hash': value['scene_hash'], 'epoch': EPOCH, 'mapping_revision': 7,
                       'codec': 'pose-f32-v1', 'coordinate_frame': 'rh-y-up-m',
                       'pose_keys': value['body_order'], 'joint_keys': value['joint_order'],
                       'targets': [{'pose_key': 'saved/body', 'entity_id': SESSION_ID,
                                    'node_id': SESSION_ID, 'visual_target': 'node-root'}],
                       'rate_hz': 30, 'simulation_rate': 1}
            await self.websocket.send(json.dumps(welcome))
            self.initial = decode_snapshot(await asyncio.wait_for(self.websocket.recv(), 3))
        except BaseException:
            await self.cleanup()
            raise

    async def cleanup(self):
        if self.process is not None:
            self.process.stdin.close()
            if self.process.returncode is None:
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), 3)
                except TimeoutError:
                    self.process.kill()
                    await self.process.wait()
            ledger('released', kind='python-publisher', pid=self.process.pid, exit_code=self.process.returncode)
        self.shutdown.set()
        self.server.close()
        await self.server.wait_closed()
        ledger('released', kind='loopback-ws-listener', port=self.port)

    async def asyncTearDown(self):
        await self.cleanup()

    async def boundary(self, action, revision):
        request = {'type': 'motion.session_control', 'session_id': SESSION_ID, 'epoch': EPOCH,
                   'transition_id': TRANSITION_ID, 'revision': revision, 'action': action}
        await self.websocket.send(json.dumps(request))
        last = None
        while True:
            message = await asyncio.wait_for(self.websocket.recv(), 3)
            if isinstance(message, bytes):
                last = decode_snapshot(message)
            else:
                ack = parse_session_ack(message)
                self.assertIsNotNone(last)
                self.assertEqual(ack['action'], action)
                self.assertEqual(ack['last_sequence'], str(last['sequence']))
                self.assertEqual(ack['sim_time_ns'], str(last['sim_time_ns']))
                self.assertEqual(decode_snapshot(self.recorded_frames[-1]), last)
                self.assertEqual(self.recorded_events[-1]['event']['action'], action)
                return last, ack

    async def test_real_source_freezes_pose_clock_keeps_pongs_and_resumes_without_paused_walltime(self):
        self.assertEqual(self.initial['sequence'], 1)
        self.assertEqual(self.initial['sim_time_ns'], 0)
        self.assertEqual(self.initial['poses'][0]['position'], [-4, 2, 8])
        self.assertEqual(self.initial['joints'], [0.25])
        await asyncio.sleep(0.08)
        paused, _ = await self.boundary('pause', 1)
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(self.websocket.recv(), 1.2)
        await asyncio.wait_for(await self.websocket.ping(), 1)
        resumed, _ = await self.boundary('resume', 2)
        self.assertEqual(resumed['sim_time_ns'], paused['sim_time_ns'])
        self.assertEqual(resumed['poses'], paused['poses'])
        self.assertGreater(resumed['sequence'], paused['sequence'])
        live = decode_snapshot(await asyncio.wait_for(self.websocket.recv(), 1))
        self.assertGreater(live['sim_time_ns'], resumed['sim_time_ns'])
        self.assertLess(live['sim_time_ns'] - resumed['sim_time_ns'], 250_000_000)
        self.assertNotEqual(live['poses'], paused['poses'])
        stopped, _ = await self.boundary('stop', 3)
        self.assertGreater(stopped['sequence'], live['sequence'])
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 3), 0)
        self.assertEqual(self.connections, 2)
        self.assertEqual([decode_snapshot(frame)['sequence'] for frame in self.recorded_frames], list(range(1, stopped['sequence'] + 1)))
        self.assertEqual(self.source_end['last_source_sequence'], str(stopped['sequence']))

    async def test_wrong_epoch_closes_owned_source_without_ack_or_reconnect(self):
        from websockets.exceptions import ConnectionClosed

        await self.websocket.send(json.dumps({'type': 'motion.session_control', 'session_id': SESSION_ID,
                                             'epoch': '1', 'transition_id': TRANSITION_ID,
                                             'revision': 1, 'action': 'pause'}))
        try:
            while True:
                message = await asyncio.wait_for(self.websocket.recv(), 3)
                self.assertIsInstance(message, bytes)
        except ConnectionClosed:
            pass
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 3), 1)
        self.assertEqual(self.connections, 2)

    async def test_changed_recording_ack_aborts_both_owned_sockets_before_motion_grace(self):
        self.alter_recording_ack = True
        started = time.monotonic()
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 1), 1)
        await asyncio.wait_for(self.websocket.wait_closed(), 0.5)
        await asyncio.wait_for(self.recording_socket.wait_closed(), 0.5)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(self.connections, 2)

    async def test_parent_stdin_eof_cleans_paused_connection_without_reconnect(self):
        await self.boundary('pause', 1)
        self.process.stdin.close()
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 3), 130)
        await asyncio.wait_for(self.websocket.wait_closed(), 3)
        self.assertEqual(self.connections, 2)

    @unittest.skipIf(sys.platform == 'win32', 'Windows termination does not deliver POSIX SIGTERM')
    async def test_sigterm_cleans_paused_connection_and_process(self):
        await self.boundary('pause', 1)
        self.process.send_signal(signal.SIGTERM)
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 3), 130)
        await asyncio.wait_for(self.websocket.wait_closed(), 3)
        self.assertEqual(self.connections, 2)


if __name__ == '__main__':
    unittest.main()
