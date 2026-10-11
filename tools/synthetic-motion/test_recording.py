"""Literal cross-language bytes and bounded collector failure/ACK counterexamples."""

import asyncio
import json
import unittest
from pathlib import Path

from motion_codec import MotionProtocolError
from recording_codec import (advance_prefix, canonical_source_header, decode_packet, encode_frame_batch,
                             encode_packet, limits, mapping_digest, parse_ack, parse_source_event,
                             sha256, source_prefix_seed)
from recording_source import ReliableRecording

VECTORS = json.loads((Path(__file__).parents[2] / 'packages/contracts/src/recording/golden-vectors.json').read_text())


class RecordingCodecTests(unittest.TestCase):
    def test_shared_literal_bytes_cover_bigint_mapping_header_seed_packet_and_ack(self):
        header = canonical_source_header(VECTORS['source_header'])
        self.assertEqual(header.decode(), VECTORS['canonical_source_header'])
        self.assertEqual(sha256(header), VECTORS['source_header_sha256'])
        self.assertEqual(mapping_digest(7, VECTORS['pose_keys'], VECTORS['joint_keys']), VECTORS['mapping_sha256'])
        self.assertEqual(source_prefix_seed(VECTORS['identity'], sha256(header)), VECTORS['source_prefix_seed'])
        packet = encode_packet(VECTORS['identity'], 1, 1, encode_frame_batch([bytes.fromhex(VECTORS['motion_frame_hex'])]))
        self.assertEqual(packet.hex(), VECTORS['frame_packet_hex'])
        self.assertEqual(decode_packet(packet)['packet_sha256'], VECTORS['packet_sha256'])
        self.assertEqual(advance_prefix(VECTORS['source_prefix_seed'], VECTORS['packet_sha256']), VECTORS['ack']['source_prefix_sha256'])
        self.assertEqual(parse_ack(json.dumps(VECTORS['ack'])), VECTORS['ack'])

    def test_altered_packet_unsupported_source_authority_and_duplicate_json_fail(self):
        packet = bytearray.fromhex(VECTORS['frame_packet_hex']); packet[-1] ^= 1
        with self.assertRaises(MotionProtocolError):
            decode_packet(packet)
        with self.assertRaises(MotionProtocolError):
            parse_ack(json.dumps(VECTORS['ack'])[:-1] + ',"type":"recording.ack"}')
        with self.assertRaises(MotionProtocolError):
            parse_source_event(json.dumps({'source_event_sequence': '1', 'event_id': VECTORS['identity']['lease_id'],
                'event_type': 'task.report', 'subject': {'session_id': VECTORS['identity']['session_id']},
                'sim_time_ns': '0', 'observed_at': None, 'event': {}}))


class FakeSocket:
    def __init__(self):
        self.transport = self
        self.sent = []
        self.inbound = asyncio.Queue(maxsize=1)
        self.source = None
        self.alter_ack = False
        self.drop_first = False

    def get_write_buffer_size(self):
        return 0

    async def send(self, packet):
        self.sent.append(packet)
        if self.drop_first and len(self.sent) == 1:
            return
        expected = dict(self.source.inflight[1])
        if self.alter_ack:
            expected['durable_source_sequence'] = str(int(expected['durable_source_sequence']) + 1)
        await self.inbound.put(json.dumps(expected))

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.inbound.get()


class ReliableCollectorTests(unittest.IsolatedAsyncioTestCase):
    def source(self):
        socket = FakeSocket()
        source = ReliableRecording(socket, VECTORS['identity'], {'limits': limits(1000, 1000),
                                                                'source_prefix_sha256': VECTORS['source_prefix_seed']})
        socket.source = source
        return source, socket

    async def run_tasks(self, source, body):
        tasks = [asyncio.create_task(source.write()), asyncio.create_task(source.read()), asyncio.create_task(source.watchdog())]
        try:
            await body(tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            source.clear()

    async def test_lost_ack_retries_exact_packet_and_releases_only_verified_retained_facts(self):
        source, socket = self.source(); socket.drop_first = True
        frame = bytes.fromhex(VECTORS['motion_frame_hex'])
        source.capture(frame, 1, True)

        async def proof(_):
            await source.drain(asyncio.get_running_loop().time() + 0.333)
            self.assertEqual(socket.sent, [bytes.fromhex(VECTORS['frame_packet_hex'])] * 2)
            self.assertEqual(source.durable_sequence, 1)
            self.assertEqual(len(source.facts), 0)
            self.assertEqual(source.retained_bytes, 0)
            self.assertEqual(source.retries, 1)
        await self.run_tasks(source, proof)

    async def test_changed_ack_faults_without_releasing_selected_bytes(self):
        source, socket = self.source(); socket.alter_ack = True
        frame = bytes.fromhex(VECTORS['motion_frame_hex']); source.capture(frame, 1, True)

        async def proof(tasks):
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED, timeout=0.5)
            self.assertTrue(done)
            with self.assertRaises(MotionProtocolError) as error:
                next(iter(done)).result()
            self.assertEqual(error.exception.code, 'invalid_ack')
            self.assertEqual(source.durable_sequence, 0)
            self.assertEqual(source.facts[0][1], frame)
        await self.run_tasks(source, proof)

    async def test_capacity_failure_preserves_existing_tail_and_idle_pause_has_no_ack_timeout(self):
        source, _ = self.source()
        watch = asyncio.create_task(source.watchdog())
        try:
            await asyncio.sleep(0.4)
            self.assertFalse(watch.done())
            source.limits['source_frames'] = 1
            source.capture(bytes.fromhex(VECTORS['motion_frame_hex']), 1)
            with self.assertRaises(MotionProtocolError) as error:
                source.capture(b'next-selected-frame', 2)
            self.assertEqual(error.exception.code, 'source_capacity')
            self.assertEqual(source.selected_sequence, 1)
            self.assertEqual(len(source.facts), 1)
        finally:
            watch.cancel()
            await asyncio.gather(watch, return_exceptions=True)
            source.clear()


if __name__ == '__main__':
    unittest.main()
