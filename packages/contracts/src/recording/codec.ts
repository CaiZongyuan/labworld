import { decodeMotionSnapshot } from '../motion/codec.ts';
import type { MotionExpectedMapping, MotionSnapshot } from '../motion/types.ts';
import {
  recordingDigest,
  recordingInteger,
  recordingU64,
  recordingUUID,
} from './control.ts';
import {
  RECORDING_HEADER_BYTES,
  RECORDING_WIRE_LIMITS,
  RecordingProtocolError,
  type RecordingIdentity,
  type RecordingPacket,
  type RecordingPacketKind,
} from './types.ts';

export function digestBytes(value: string): Uint8Array {
  recordingDigest(value);
  return Uint8Array.from(value.slice(7).match(/../g)!, (pair) =>
    Number.parseInt(pair, 16),
  );
}
export function uuidBytes(value: string): Uint8Array {
  recordingUUID(value);
  return Uint8Array.from(value.replaceAll('-', '').match(/../g)!, (pair) =>
    Number.parseInt(pair, 16),
  );
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}
function uuid(bytes: Uint8Array): string {
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export function concatRecordingBytes(
  ...values: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    values.reduce((sum, value) => sum + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return bytes;
}
export async function recordingSHA256(bytes: Uint8Array): Promise<string> {
  // A bounded copy also handles views backed by SharedArrayBuffer safely.
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))}`;
}
export async function mappingDigest(mapping: {
  mapping_revision: number;
  pose_keys: readonly string[];
  joint_keys: readonly string[];
}): Promise<string> {
  recordingInteger(mapping.mapping_revision);
  if (mapping.pose_keys.length > 1024 || mapping.joint_keys.length > 1024)
    throw new RecordingProtocolError(
      'mapping_mismatch',
      'Mapping exceeds dictionary bounds',
    );
  const fixed = new Uint8Array(12);
  const view = new DataView(fixed.buffer);
  view.setUint32(0, mapping.mapping_revision, true);
  view.setUint32(4, mapping.pose_keys.length, true);
  view.setUint32(8, mapping.joint_keys.length, true);
  const entries: Uint8Array[] = [];
  for (const keys of [mapping.pose_keys, mapping.joint_keys]) {
    if (new Set(keys).size !== keys.length)
      throw new RecordingProtocolError(
        'mapping_mismatch',
        'Mapping keys must be unique',
      );
    for (const key of keys) {
      if (typeof key !== 'string')
        throw new RecordingProtocolError(
          'mapping_mismatch',
          'Mapping key must be a string',
        );
      const bytes = new TextEncoder().encode(key);
      if (
        !key ||
        bytes.byteLength > 128 ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          key,
        )
      )
        throw new RecordingProtocolError(
          'mapping_mismatch',
          'Invalid mapping key',
        );
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, bytes.byteLength, true);
      entries.push(length, bytes);
    }
  }
  return recordingSHA256(
    concatRecordingBytes(
      new TextEncoder().encode('LWR1-MAPPING\0'),
      fixed,
      ...entries,
    ),
  );
}
export async function sourcePrefixSeed(
  identity: RecordingIdentity,
  sourceHeaderSHA256: string,
): Promise<string> {
  const epoch = new Uint8Array(8);
  new DataView(epoch.buffer).setBigUint64(
    0,
    recordingU64(identity.epoch),
    true,
  );
  return recordingSHA256(
    concatRecordingBytes(
      new TextEncoder().encode('LWR1-SOURCE\0'),
      uuidBytes(identity.recording_id),
      uuidBytes(identity.session_id),
      uuidBytes(identity.lease_id),
      epoch,
      digestBytes(identity.manifest_sha256),
      digestBytes(identity.snapshot_hash),
      digestBytes(identity.mapping_sha256),
      digestBytes(sourceHeaderSHA256),
    ),
  );
}
export async function advanceSourcePrefix(
  previous: string,
  packetDigest: string,
): Promise<string> {
  return recordingSHA256(
    concatRecordingBytes(digestBytes(previous), digestBytes(packetDigest)),
  );
}
export async function encodeRecordingPacket(
  packet: Omit<RecordingPacket, 'packet_sha256'>,
): Promise<Uint8Array> {
  if (
    typeof packet.epoch !== 'bigint' ||
    typeof packet.source_packet_sequence !== 'bigint'
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Source packet u64 fields require BigInt',
    );
  if (![1, 2, 3].includes(packet.kind))
    throw new RecordingProtocolError(
      'invalid_packet',
      'Unsupported source packet kind',
    );
  if (
    (packet.kind === 2 &&
      packet.payload.byteLength > RECORDING_WIRE_LIMITS.event_bytes) ||
    (packet.kind === 3 &&
      packet.payload.byteLength > RECORDING_WIRE_LIMITS.end_bytes)
  )
    throw new RecordingProtocolError(
      'source_capacity',
      'Source fact exceeds its payload budget',
    );
  const bytes = new Uint8Array(
    RECORDING_HEADER_BYTES + packet.payload.byteLength,
  );
  if (bytes.byteLength > RECORDING_WIRE_LIMITS.packet_bytes)
    throw new RecordingProtocolError(
      'source_capacity',
      'Source packet exceeds byte budget',
    );
  const view = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x57, 0x52, 0x31, 1, packet.kind, 0, 0]);
  bytes.set(uuidBytes(packet.recording_id), 8);
  bytes.set(uuidBytes(packet.session_id), 24);
  view.setBigUint64(40, recordingU64(packet.epoch.toString()), true);
  const sequence = recordingU64(packet.source_packet_sequence.toString());
  if (sequence === 0n)
    throw new RecordingProtocolError(
      'sequence_gap',
      'Source packet sequence starts at one',
    );
  view.setBigUint64(48, sequence, true);
  view.setUint32(56, packet.payload.byteLength, true);
  bytes.set(packet.payload, RECORDING_HEADER_BYTES);
  bytes.set(
    digestBytes(
      await recordingSHA256(
        concatRecordingBytes(bytes.subarray(0, 64), packet.payload),
      ),
    ),
    64,
  );
  return bytes;
}
export async function decodeRecordingPacket(
  input: Uint8Array,
  expected?: Pick<RecordingIdentity, 'recording_id' | 'session_id' | 'epoch'>,
): Promise<RecordingPacket> {
  if (
    input.byteLength < RECORDING_HEADER_BYTES ||
    input.byteLength > RECORDING_WIRE_LIMITS.packet_bytes
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Invalid source packet length',
    );
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const kind = view.getUint8(5);
  if (
    (kind === 2 &&
      input.byteLength - RECORDING_HEADER_BYTES >
        RECORDING_WIRE_LIMITS.event_bytes) ||
    (kind === 3 &&
      input.byteLength - RECORDING_HEADER_BYTES >
        RECORDING_WIRE_LIMITS.end_bytes)
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Source fact exceeds its payload budget',
    );
  if (
    view.getUint32(0, false) !== 0x4c575231 ||
    view.getUint8(4) !== 1 ||
    ![1, 2, 3].includes(kind) ||
    view.getUint16(6, true) !== 0 ||
    view.getUint32(60, true) !== 0 ||
    view.getUint32(56, true) !== input.byteLength - RECORDING_HEADER_BYTES
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Invalid source packet header',
    );
  const recording_id = uuid(input.subarray(8, 24)),
    session_id = uuid(input.subarray(24, 40));
  const epoch = view.getBigUint64(40, true),
    source_packet_sequence = view.getBigUint64(48, true);
  if (source_packet_sequence === 0n)
    throw new RecordingProtocolError(
      'sequence_gap',
      'Source packet sequence starts at one',
    );
  if (
    expected &&
    (recording_id !== expected.recording_id ||
      session_id !== expected.session_id ||
      epoch !== recordingU64(expected.epoch))
  )
    throw new RecordingProtocolError(
      'scope_mismatch',
      'Source packet is outside its admitted scope',
    );
  const payload = input.subarray(RECORDING_HEADER_BYTES);
  const packet_sha256 = await recordingSHA256(
    concatRecordingBytes(input.subarray(0, 64), payload),
  );
  if (hex(input.subarray(64, 96)) !== packet_sha256.slice(7))
    throw new RecordingProtocolError(
      'altered_duplicate',
      'Source packet digest mismatch',
    );
  return {
    kind: kind as RecordingPacketKind,
    recording_id,
    session_id,
    epoch,
    source_packet_sequence,
    packet_sha256,
    payload,
  };
}
export function encodeFrameBatch(frames: readonly Uint8Array[]): Uint8Array {
  if (
    !frames.length ||
    frames.length > RECORDING_WIRE_LIMITS.frame_batch_frames
  )
    throw new RecordingProtocolError(
      'source_capacity',
      'Invalid source batch count',
    );
  const first = decodeMotionSnapshot(frames[0]);
  if (first.sequence === 0n)
    throw new RecordingProtocolError(
      'sequence_gap',
      'Selected source sequence starts at one',
    );
  const frameBytes = frames[0].byteLength;
  let time = first.sim_time_ns;
  frames.forEach((frame, index) => {
    const snapshot = decodeMotionSnapshot(frame, {
      epoch: first.epoch,
      mapping_revision: first.mapping_revision,
      body_count: first.poses.length,
      joint_count: first.joints.length,
    });
    if (
      frame.byteLength !== frameBytes ||
      snapshot.sequence !== first.sequence + BigInt(index) ||
      snapshot.sim_time_ns < time
    )
      throw new RecordingProtocolError(
        'sequence_gap',
        'Source frames must form a continuous selected prefix',
      );
    time = snapshot.sim_time_ns;
  });
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setBigUint64(0, first.sequence, true);
  view.setUint32(8, frames.length, true);
  view.setUint32(12, frameBytes, true);
  if (
    16 + frames.length * frameBytes + RECORDING_HEADER_BYTES >
    RECORDING_WIRE_LIMITS.packet_bytes
  )
    throw new RecordingProtocolError(
      'source_capacity',
      'Source batch exceeds byte budget',
    );
  return concatRecordingBytes(header, ...frames);
}
export function decodeFrameBatch(
  payload: Uint8Array,
  expected: MotionExpectedMapping,
): {
  first_source_sequence: bigint;
  frames: readonly { bytes: Uint8Array; snapshot: MotionSnapshot }[];
} {
  if (
    payload.byteLength < 16 ||
    payload.byteLength + RECORDING_HEADER_BYTES >
      RECORDING_WIRE_LIMITS.packet_bytes
  )
    throw new RecordingProtocolError('invalid_packet', 'Truncated frame batch');
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const first = view.getBigUint64(0, true),
    count = view.getUint32(8, true),
    frameBytes = view.getUint32(12, true);
  if (
    first === 0n ||
    count === 0 ||
    count > 32 ||
    frameBytes !== 48 + 28 * expected.body_count + 4 * expected.joint_count ||
    payload.byteLength !== 16 + count * frameBytes
  )
    throw new RecordingProtocolError(
      'invalid_packet',
      'Frame batch does not match immutable mapping',
    );
  const frames: { bytes: Uint8Array; snapshot: MotionSnapshot }[] = [];
  let time = 0n;
  for (let index = 0; index < count; index++) {
    const bytes = payload.subarray(
      16 + index * frameBytes,
      16 + (index + 1) * frameBytes,
    );
    const snapshot = decodeMotionSnapshot(bytes, expected);
    if (
      snapshot.sequence !== first + BigInt(index) ||
      snapshot.sim_time_ns < time
    )
      throw new RecordingProtocolError(
        'sequence_gap',
        'Frame batch has a gap or time rollback',
      );
    frames.push({ bytes, snapshot });
    time = snapshot.sim_time_ns;
  }
  return { first_source_sequence: first, frames };
}
