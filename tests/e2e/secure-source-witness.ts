import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSelectedBytes,
  recordedFrames,
  recordedSourcePackets,
  type RecordingRecord,
} from './recording-wire-oracle.ts';

function spool(session: string, suffix: string) {
  assert.match(session, /^[0-9a-f-]{36}$/);
  const bytes = readFileSync(
    join(process.env.SECURE_MOTION_SOURCE_WITNESS!, session + '.' + suffix),
  );
  assert(bytes.length <= 16 * 1024 * 1024);
  const rows: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert(bytes.length - offset >= 4, 'Torn source witness length');
    const size = bytes.readUInt32LE(offset);
    offset += 4;
    assert(
      size > 0 && size <= 65536 && size <= bytes.length - offset,
      'Torn source witness bytes',
    );
    rows.push(bytes.subarray(offset, offset + size));
    assert(rows.length <= 10000);
    offset += size;
  }
  return rows;
}
/** Compare real selection and packet attempts with public durable bytes. */
export function assertSourceWitness(
  session: string,
  records: readonly RecordingRecord[],
  complete: boolean,
  confirmedPackets?: readonly Uint8Array[],
) {
  const actual = recordedSourcePackets(records),
    selected = spool(session, 'frames'),
    attempts = spool(session, 'packets');
  const bySequence = new Map<string, Buffer>();
  for (const packet of attempts) {
    const key = packet.readBigUInt64LE(48).toString();
    const old = bySequence.get(key);
    if (old) assert.deepEqual(packet, old, 'Source altered a packet retry');
    else bySequence.set(key, packet);
  }
  const packets = [...bySequence.values()];
  if (complete) assertSelectedBytes(actual, packets);
  else {
    assert(confirmedPackets?.length, 'Missing public before-fault prefix');
    assertSelectedBytes(
      actual.slice(0, confirmedPackets.length),
      confirmedPackets,
    );
    assertSelectedBytes(actual, packets.slice(0, actual.length));
  }
  const frames = recordedFrames(actual);
  selected.forEach((frame, index) => {
    assert.equal(frame.length, 632);
    assert.equal(frame.readBigUInt64LE(16), BigInt(index + 1));
  });
  if (complete) assertSelectedBytes(frames, selected);
  else assertSelectedBytes(frames, selected.slice(0, frames.length));
  return {
    selectedFrames: selected.length,
    retainedFrames: frames.length,
    selectedPackets: packets.length,
    confirmedPackets: confirmedPackets?.length ?? actual.length,
    retainedPackets: actual.length,
    unconfirmedSelectedTail: selected.length - frames.length,
    exactByteEquality: true,
  };
}
