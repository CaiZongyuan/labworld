"""Stdlib checks for the Python-facing contract and bounded synthetic source."""

import asyncio
import json
import math
import struct
import unittest
from pathlib import Path

from motion_codec import MAX_BODIES, MotionProtocolError, decode_snapshot, encode_snapshot, parse_u64
from publisher import LatestSnapshot, transport_url
from synthetic import JOINT_KEYS, POSE_KEYS, synthetic_snapshot

VECTORS = json.loads((Path(__file__).resolve().parents[2]
                     / 'packages/contracts/src/motion/fixtures/golden-v1.json').read_text())


def snapshot_from_json(value):
    return {**value, **{name: parse_u64(value[name]) for name in ('epoch', 'sequence', 'sim_time_ns')}}


class MotionTests(unittest.TestCase):
    def assert_code(self, code, operation):
        with self.assertRaises(MotionProtocolError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)

    def test_literal_vectors(self):
        for vector in VECTORS['vectors']:
            with self.subTest(vector=vector['name']):
                snapshot = snapshot_from_json(vector['snapshot'])
                self.assertEqual(encode_snapshot(snapshot).hex(), vector['hex'])
                self.assertEqual(decode_snapshot(bytes.fromhex(vector['hex'])), snapshot)

    def test_malformed_vectors(self):
        for case in VECTORS['malformed']:
            with self.subTest(case=case['name']):
                data = bytearray.fromhex(VECTORS['vectors'][0]['hex'])
                patch = bytes.fromhex(case['hex'])
                data[case['offset']:case['offset'] + len(patch)] = patch
                self.assert_code(case['code'], lambda: decode_snapshot(data))

    def test_slices_lengths_and_admission(self):
        data = bytes.fromhex(VECTORS['vectors'][0]['hex'])
        self.assertEqual(decode_snapshot(memoryview(b'prefix!' + data + b'suffix')[7:7 + len(data)]),
                         snapshot_from_json(VECTORS['vectors'][0]['snapshot']))
        self.assert_code('invalid_length', lambda: decode_snapshot(data[:-1]))
        self.assert_code('invalid_length', lambda: decode_snapshot(data + b'\0'))
        expected = {'mapping_revision': 16909060, 'body_count': 1, 'joint_count': 1, 'epoch': 9007199254740993}
        self.assertEqual(decode_snapshot(data, expected)['epoch'], expected['epoch'])
        self.assert_code('epoch_mismatch', lambda: decode_snapshot(data, {**expected, 'epoch': 1}))
        self.assert_code('mapping_mismatch', lambda: decode_snapshot(data, {**expected, 'body_count': 2}))

    def test_encoder_bounds_and_no_normalization(self):
        base = snapshot_from_json(VECTORS['vectors'][0]['snapshot'])
        for integer in (-1, 1 << 64, 1.0, True):
            self.assert_code('invalid_u64', lambda: encode_snapshot({**base, 'epoch': integer}))
        self.assert_code('limit_exceeded', lambda: encode_snapshot({**base, 'poses': base['poses'] * (MAX_BODIES + 1)}))
        self.assert_code('invalid_quaternion', lambda: encode_snapshot({**base, 'poses': [
            {'position': [0, 0, 0], 'quaternion': [0, 0, 0, 0.9]}]}))
        self.assert_code('invalid_number', lambda: encode_snapshot({**base, 'joints': [math.inf]}))
        for value in ('01', '-1', '1e3', '18446744073709551616'):
            self.assert_code('invalid_u64', lambda: parse_u64(value))

    def test_deterministic_trajectory_independent_known_time_and_indices(self):
        snapshot = synthetic_snapshot(3, 1, 0, 7)
        self.assertEqual(len(snapshot['poses']), 20)
        self.assertEqual(len(snapshot['joints']), 6)
        self.assertEqual(POSE_KEYS[19], 'synthetic/body/19')
        self.assertEqual(JOINT_KEYS[5], 'synthetic/joint/5')
        # Body zero at t=0 from the formula, independently stated constants.
        body = snapshot['poses'][0]
        self.assertEqual(body['position'][0], -3.2)
        self.assertAlmostEqual(body['position'][1], 0.65)
        self.assertAlmostEqual(body['position'][2], -1.75)
        self.assertEqual(body['quaternion'], [0, 0, 0, 1])
        self.assertEqual(snapshot['joints'][0], 0)
        later = synthetic_snapshot(3, 31, 1_000_000_000, 7)
        self.assertAlmostEqual(later['poses'][0]['position'][0], -2.821338056836446)
        self.assertAlmostEqual(later['poses'][19]['position'][2], 2.1306246442038064)
        self.assertAlmostEqual(later['joints'][5], 0.45464871341284085)
        data = encode_snapshot(later)
        self.assertEqual(len(data), 632)
        self.assertEqual(struct.unpack_from('<Q', data, 24)[0], 1_000_000_000)

    def test_remote_transport_requires_tls(self):
        for url in ('ws://127.0.0.1:8080/publisher', 'ws://[::1]/publisher', 'wss://example.invalid/publisher'):
            self.assertEqual(transport_url(url), url)
        for url in ('ws://192.168.1.1/publisher', 'http://localhost/publisher',
                    'wss://user:secret@example.invalid/publisher', 'wss://example.invalid/publisher?ticket=secret'):
            with self.assertRaises(ValueError):
                transport_url(url)


class PendingTests(unittest.IsolatedAsyncioTestCase):
    async def test_writer_gets_latest_slot_with_a_fixed_pending_bound(self):
        slot = LatestSnapshot()
        for index in range(1000):
            slot.offer(bytes([index % 256]))
        self.assertEqual(slot.overwritten, 999)
        self.assertEqual(await slot.take(), bytes([999 % 256]))
        self.assertIsNone(slot.value)
        self.assertFalse(slot.ready.is_set())
        waiting = asyncio.create_task(slot.take())
        slot.offer(b'fresh')
        self.assertEqual(await waiting, b'fresh')


if __name__ == '__main__':
    unittest.main()
