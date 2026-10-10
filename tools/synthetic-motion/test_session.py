"""Startup/clock checks and optional real subprocess + ordered WS lifecycle checks."""

import asyncio
import dataclasses
import importlib.util
import json
import math
import os
import signal
import sys
import time
import unittest
from pathlib import Path

from motion_codec import MotionProtocolError, decode_snapshot, parse_session_ack
from publisher import SessionOutbox, SimulationClock
from synthetic import configured_snapshot, parse_startup

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
            stream.write(json.dumps({'at_ns': time.time_ns(), 'owner': 'bridge-71-source-check',
                                     'event': event, **resource}) + '\n')


@unittest.skipUnless(importlib.util.find_spec('websockets'), 'optional pinned WebSocket dependency unavailable')
class SourceSocketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from websockets.asyncio.server import serve

        self.connection = asyncio.get_running_loop().create_future()
        self.shutdown = asyncio.Event()
        self.connections = 0
        self.process = None

        async def handler(websocket):
            self.connections += 1
            if not self.connection.done():
                self.connection.set_result(websocket)
            await self.shutdown.wait()

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
        self.assertEqual(self.connections, 1)

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
        self.assertEqual(self.connections, 1)

    async def test_parent_stdin_eof_cleans_paused_connection_without_reconnect(self):
        await self.boundary('pause', 1)
        self.process.stdin.close()
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 3), 130)
        await asyncio.wait_for(self.websocket.wait_closed(), 3)
        self.assertEqual(self.connections, 1)

    @unittest.skipIf(sys.platform == 'win32', 'Windows termination does not deliver POSIX SIGTERM')
    async def test_sigterm_cleans_paused_connection_and_process(self):
        await self.boundary('pause', 1)
        self.process.send_signal(signal.SIGTERM)
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 3), 130)
        await asyncio.wait_for(self.websocket.wait_closed(), 3)
        self.assertEqual(self.connections, 1)


if __name__ == '__main__':
    unittest.main()
