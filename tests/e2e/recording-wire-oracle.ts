import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SimulationSession } from '../../packages/contracts/src/generated/types.gen.ts';

// Independent implementation of the published byte layout. No production
// Recording/Motion encoder, parser, digest helper or recorder counter is used.
export const capturePolicy = {
  selection: 'all-selected',
  sample_hz: 30,
  motion_codec: 'pose-f32-v1',
  first_source_sequence: '1',
  first_source_event_sequence: '1',
} as const;

export type RecordingIdentity = {
  recording_id: string;
  session_id: string;
  lease_id: string;
  epoch: string;
  snapshot_hash: string;
  manifest_sha256: string;
  scene_hash: string;
  mapping_revision: number;
  mapping_sha256: string;
};

export type SourceHeader = {
  source_kind: 'synthetic';
  implementation: { name: string; version: string; sha256: null };
  python_version: null;
  dependencies: [];
  capture_policy: typeof capturePolicy;
};

export type SourceAck = {
  type: 'recording.ack';
  version: 1;
  recording_id: string;
  session_id: string;
  lease_id: string;
  epoch: string;
  source_packet_sequence: string;
  packet_sha256: string;
  source_prefix_sha256: string;
  durable_source_sequence: string;
  durable_source_event_sequence: string;
  source_ended: boolean;
};

export function digest(bytes: Uint8Array) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function rawDigest(value: string) {
  assert.match(value, /^sha256:[0-9a-f]{64}$/);
  return Buffer.from(value.slice(7), 'hex');
}

function uuidBytes(value: string) {
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

export function sourceHeader(): SourceHeader {
  return {
    source_kind: 'synthetic',
    implementation: {
      name: 'independent-recording-e2e-machine',
      version: '1',
      sha256: null,
    },
    python_version: null,
    dependencies: [],
    capture_policy: { ...capturePolicy },
  };
}

export function canonicalHeader(header: SourceHeader) {
  // Each key is written in the published order, rather than trusting arbitrary
  // object insertion order from a returned server header.
  return Buffer.from(
    JSON.stringify({
      source_kind: header.source_kind,
      implementation: {
        name: header.implementation.name,
        version: header.implementation.version,
        sha256: header.implementation.sha256,
      },
      python_version: header.python_version,
      dependencies: [],
      capture_policy: {
        selection: 'all-selected',
        sample_hz: 30,
        motion_codec: 'pose-f32-v1',
        first_source_sequence: '1',
        first_source_event_sequence: '1',
      },
    }),
    'utf8',
  );
}

export function mappingDigest(session: SimulationSession) {
  const installation = session.snapshot.installation;
  const keys = [...installation.pose_keys, ...installation.joint_keys];
  return digest(
    Buffer.concat([
      Buffer.from('LWR1-MAPPING\0', 'utf8'),
      u32(installation.mapping_revision),
      u32(installation.pose_keys.length),
      u32(installation.joint_keys.length),
      ...keys.flatMap((key) => {
        const bytes = Buffer.from(key, 'utf8');
        return [u32(bytes.length), bytes];
      }),
    ]),
  );
}

export function initialPrefix(scope: RecordingIdentity, header: SourceHeader) {
  return digest(
    Buffer.concat([
      Buffer.from('LWR1-SOURCE\0', 'utf8'),
      uuidBytes(scope.recording_id),
      uuidBytes(scope.session_id),
      uuidBytes(scope.lease_id),
      u64(BigInt(scope.epoch)),
      rawDigest(scope.manifest_sha256),
      rawDigest(scope.snapshot_hash),
      rawDigest(scope.mapping_sha256),
      rawDigest(digest(canonicalHeader(header))),
    ]),
  );
}

export function nextPrefix(previous: string, packetHash: string) {
  return digest(Buffer.concat([rawDigest(previous), rawDigest(packetHash)]));
}

export function selectedFrame(
  session: SimulationSession,
  sequence: bigint,
  time: bigint,
  offset = 0,
) {
  assert(session.epoch);
  const initial = session.snapshot;
  assert.equal(initial.initial_poses.length, 20);
  assert.equal(initial.initial_joints.length, 6);
  const bytes = Buffer.alloc(632);
  bytes.write('LWM1', 0, 'ascii');
  bytes[4] = 1;
  bytes[5] = 1;
  bytes.writeBigUInt64LE(BigInt(session.epoch), 8);
  bytes.writeBigUInt64LE(sequence, 16);
  bytes.writeBigUInt64LE(time, 24);
  bytes.writeUInt32LE(initial.installation.mapping_revision, 32);
  bytes.writeUInt32LE(20, 36);
  bytes.writeUInt32LE(6, 40);
  bytes.writeUInt32LE(584, 44);
  initial.initial_poses.forEach((pose, index) => {
    pose.position.forEach((component, axis) =>
      bytes.writeFloatLE(
        component + (axis === 0 ? offset : 0),
        48 + index * 28 + axis * 4,
      ),
    );
    pose.quaternion.forEach((component, axis) =>
      bytes.writeFloatLE(component, 60 + index * 28 + axis * 4),
    );
  });
  initial.initial_joints.forEach((component, index) =>
    bytes.writeFloatLE(component, 608 + index * 4),
  );
  return bytes;
}

export function frameBatch(frames: readonly Buffer[]) {
  assert(frames.length >= 1 && frames.length <= 32);
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(frames[0].readBigUInt64LE(16), 0);
  header.writeUInt32LE(frames.length, 8);
  header.writeUInt32LE(632, 12);
  frames.forEach((frame, index) => {
    assert.equal(frame.length, 632);
    assert.equal(
      frame.readBigUInt64LE(16),
      frames[0].readBigUInt64LE(16) + BigInt(index),
    );
  });
  return Buffer.concat([header, ...frames]);
}

export function sourcePacket(
  scope: RecordingIdentity,
  kind: 1 | 2 | 3,
  sequence: bigint,
  payload: Buffer,
) {
  assert(payload.length + 96 <= 65536);
  const header = Buffer.alloc(96);
  header.write('LWR1', 0, 'ascii');
  header[4] = 1;
  header[5] = kind;
  uuidBytes(scope.recording_id).copy(header, 8);
  uuidBytes(scope.session_id).copy(header, 24);
  header.writeBigUInt64LE(BigInt(scope.epoch), 40);
  header.writeBigUInt64LE(sequence, 48);
  header.writeUInt32LE(payload.length, 56);
  const packetHash = digest(Buffer.concat([header.subarray(0, 64), payload]));
  rawDigest(packetHash).copy(header, 64);
  return { bytes: Buffer.concat([header, payload]), digest: packetHash };
}

export function assertAck(
  actual: SourceAck,
  scope: RecordingIdentity,
  expected: {
    packetSequence: bigint;
    packetHash: string;
    prefixHash: string;
    sourceSequence: bigint;
    eventSequence: bigint;
    ended: boolean;
  },
) {
  assert.deepEqual(actual, {
    type: 'recording.ack',
    version: 1,
    recording_id: scope.recording_id,
    session_id: scope.session_id,
    lease_id: scope.lease_id,
    epoch: scope.epoch,
    source_packet_sequence: String(expected.packetSequence),
    packet_sha256: expected.packetHash,
    source_prefix_sha256: expected.prefixHash,
    durable_source_sequence: String(expected.sourceSequence),
    durable_source_event_sequence: String(expected.eventSequence),
    source_ended: expected.ended,
  });
}

export function assertSelectedBytes(
  actual: readonly Uint8Array[],
  expected: readonly Uint8Array[],
) {
  assert.equal(actual.length, expected.length, 'Selected sample count changed');
  actual.forEach((bytes, index) => {
    assert.deepEqual(Buffer.from(bytes), Buffer.from(expected[index]));
  });
}

export type RecordingRecord = {
  ordinal: string;
  kind: string;
  recorded_at: string;
  data: Record<string, unknown>;
};

export function readRecordingRecords(bytes: Buffer): RecordingRecord[] {
  assert(bytes.length <= 1024 * 1024);
  const records: RecordingRecord[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert(bytes.length - offset >= 36, 'Torn LWF header');
    const size = bytes.readUInt32LE(offset);
    assert(size > 0 && size <= 128 * 1024);
    assert(size <= bytes.length - offset - 36, 'Torn LWF payload');
    const payload = bytes.subarray(offset + 36, offset + 36 + size);
    assert.equal(
      digest(payload).slice(7),
      bytes.subarray(offset + 4, offset + 36).toString('hex'),
    );
    const record = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(payload),
    ) as RecordingRecord;
    assert.match(record.ordinal, /^(0|[1-9][0-9]*)$/);
    assert.equal(typeof record.kind, 'string');
    assert.equal(typeof record.recorded_at, 'string');
    assert(record.data && typeof record.data === 'object');
    records.push(record);
    offset += 36 + size;
  }
  return records;
}

export function recordedSourcePackets(records: readonly RecordingRecord[]) {
  return records
    .filter((record) => record.kind === 'source.packet')
    .map((record) => {
      const bytes = Buffer.from(String(record.data.packet_base64), 'base64');
      assert(bytes.length >= 96 && bytes.length <= 65536);
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'LWR1');
      assert.equal(bytes[4], 1);
      assert.equal(bytes.readUInt16LE(6), 0);
      assert.equal(bytes.readUInt32LE(60), 0);
      assert.equal(bytes.readUInt32LE(56), bytes.length - 96);
      assert.equal(
        digest(
          Buffer.concat([bytes.subarray(0, 64), bytes.subarray(96)]),
        ).slice(7),
        bytes.subarray(64, 96).toString('hex'),
      );
      return bytes;
    });
}

export function recordedFrames(packets: readonly Buffer[]) {
  return packets.flatMap((packet) => {
    if (packet[5] !== 1) return [];
    const payload = packet.subarray(96),
      count = payload.readUInt32LE(8),
      size = payload.readUInt32LE(12);
    assert(count > 0 && count <= 32);
    assert.equal(payload.length, 16 + count * size);
    return Array.from({ length: count }, (_, index) => {
      const frame = payload.subarray(
        16 + index * size,
        16 + (index + 1) * size,
      );
      assert.equal(frame.subarray(0, 4).toString('ascii'), 'LWM1');
      assert.equal(
        frame.readBigUInt64LE(16),
        payload.readBigUInt64LE(0) + BigInt(index),
      );
      return frame;
    });
  });
}
