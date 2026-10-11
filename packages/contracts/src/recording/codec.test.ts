import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vectors from './golden-vectors.json';
import {
  advanceSourcePrefix,
  canonicalSourceHeader,
  decodeFrameBatch,
  decodeRecordingPacket,
  encodeFrameBatch,
  encodeRecordingPacket,
  mappingDigest,
  parseRecordingAck,
  parseSourceEnd,
  parseSourceEvent,
  parseSourceHeader,
  recordingJSON,
  recordingLimits,
  recordingSHA256,
  sourcePrefixSeed,
} from './index.ts';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const bytes = (value: string) =>
  Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));

describe('literal cross-language Recording contract', () => {
  it('commits the fixed canonical header, ordered mapping, source identity and full frame bytes', async () => {
    const header = canonicalSourceHeader(vectors.source_header);
    expect(new TextDecoder().decode(header)).toBe(
      vectors.canonical_source_header,
    );
    expect(await recordingSHA256(header)).toBe(vectors.source_header_sha256);
    expect(
      await mappingDigest({
        mapping_revision: 7,
        pose_keys: vectors.pose_keys,
        joint_keys: vectors.joint_keys,
      }),
    ).toBe(vectors.mapping_sha256);
    expect(
      await sourcePrefixSeed(vectors.identity, vectors.source_header_sha256),
    ).toBe(vectors.source_prefix_seed);
    const frame = bytes(vectors.motion_frame_hex);
    const packet = await encodeRecordingPacket({
      kind: 1,
      recording_id: vectors.identity.recording_id,
      session_id: vectors.identity.session_id,
      epoch: BigInt(vectors.identity.epoch),
      source_packet_sequence: 1n,
      payload: encodeFrameBatch([frame]),
    });
    expect(packet).toEqual(bytes(vectors.frame_packet_hex));
    const decoded = await decodeRecordingPacket(packet, vectors.identity);
    expect(decoded.packet_sha256).toBe(vectors.packet_sha256);
    expect(
      await advanceSourcePrefix(
        vectors.source_prefix_seed,
        decoded.packet_sha256,
      ),
    ).toBe(vectors.ack.source_prefix_sha256);
    expect(
      decodeFrameBatch(decoded.payload, {
        epoch: BigInt(vectors.identity.epoch),
        mapping_revision: 7,
        body_count: 1,
        joint_count: 1,
      }).frames[0].bytes,
    ).toEqual(frame);
    expect(parseRecordingAck(JSON.stringify(vectors.ack))).toEqual(vectors.ack);
  });
  it('rejects altered bytes, wrong scope, truncation and reserved fields before acceptance', async () => {
    const original = bytes(vectors.frame_packet_hex);
    const altered = original.slice();
    altered[altered.length - 1] ^= 1;
    await expect(decodeRecordingPacket(altered)).rejects.toMatchObject({
      code: 'altered_duplicate',
    });
    await expect(
      decodeRecordingPacket(original, { ...vectors.identity, epoch: '1' }),
    ).rejects.toMatchObject({ code: 'scope_mismatch' });
    await expect(
      decodeRecordingPacket(original.subarray(0, 95)),
    ).rejects.toMatchObject({ code: 'invalid_packet' });
    const reserved = original.slice();
    reserved[60] = 1;
    await expect(decodeRecordingPacket(reserved)).rejects.toMatchObject({
      code: 'invalid_packet',
    });
  });
  it('rejects extra/duplicate fields, unsorted dependencies and unsupported source authority', () => {
    expect(() =>
      parseSourceHeader({ ...vectors.source_header, extra: null }),
    ).toThrow();
    expect(() =>
      parseSourceHeader({
        ...vectors.source_header,
        dependencies: [
          { name: 'z', version: null, sha256: null },
          { name: 'a', version: null, sha256: null },
        ],
      }),
    ).toThrow();
    expect(() => recordingJSON('{"type":"x","type":"y"}', 4096)).toThrow();
    expect(() =>
      parseRecordingAck(
        JSON.stringify({ ...vectors.ack, source_packet_sequence: '01' }),
      ),
    ).toThrow();
    const event = {
      source_event_sequence: '1',
      event_id: vectors.identity.lease_id,
      event_type: 'lifecycle.applied',
      subject: { session_id: vectors.identity.session_id },
      sim_time_ns: '0',
      observed_at: null,
      event: {
        transition_id: vectors.identity.lease_id,
        revision: 1,
        action: 'pause',
        boundary_source_sequence: '1',
      },
    };
    expect(parseSourceEvent(JSON.stringify(event))).toEqual(event);
    expect(() =>
      parseSourceEvent(JSON.stringify({ ...event, event_type: 'task.report' })),
    ).toThrow();
    const end = {
      transition_id: vectors.identity.lease_id,
      revision: 1,
      reason: 'stop',
      last_source_sequence: '1',
      last_source_event_sequence: '1',
      sim_time_ns: '0',
    };
    expect(parseSourceEnd(JSON.stringify(end))).toEqual(end);
    expect(() =>
      parseSourceEnd(JSON.stringify({ ...end, reason: 'reset' })),
    ).toThrow();
  });
  it('derives every source deadline from the admitted lifecycle deadline', () => {
    expect(recordingLimits(1000, 1000)).toMatchObject({
      durability_timeout_ms: 333,
      retry_first_ms: 111,
      retry_second_ms: 222,
      sync_flush_ms: 83,
    });
    expect(recordingLimits()).toMatchObject({
      durability_timeout_ms: 1000,
      retry_first_ms: 333,
      retry_second_ms: 666,
      sync_flush_ms: 100,
    });
  });
});
