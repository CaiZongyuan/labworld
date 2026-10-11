import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventPosition,
  recordingEventPage,
} from '../../packages/server/src/lab/recordings/event-page.ts';
import {
  decodeJournalBytes,
  encodeJournalRecord,
  journalDigest,
  type JournalRecord,
} from '../../packages/server/src/lab/recordings/journal.ts';
import {
  sourcePacket,
  frameBatch,
  type RecordingIdentity,
} from '../e2e/recording-wire-oracle.ts';

const id = '10000000-0000-0000-0000-000000000001';
const row = (
  ordinal: number,
  kind: string,
  data: Record<string, unknown>,
): JournalRecord => ({
  ordinal: String(ordinal),
  kind,
  data,
  recorded_at: '2026-10-11T00:00:00Z',
});
function fixture(parts: JournalRecord[][]) {
  let windows = 0;
  return {
    count: () => windows,
    window: async (after: string) => {
      windows++;
      const index = parts.findIndex(
        (part) => BigInt(part.at(-1)!.ordinal) > BigInt(after),
      );
      return {
        records:
          index < 0
            ? []
            : parts[index].filter((r) => BigInt(r.ordinal) > BigInt(after)),
        more: index >= 0 && index < parts.length - 1,
        at: async (ordinal: string) =>
          parts.flat().find((r) => r.ordinal === ordinal),
      };
    },
  };
}
async function collect(parts: JournalRecord[][], limit = 1, old?: object) {
  const f = fixture(parts);
  const result: Record<string, unknown>[] = [];
  const cursors: string[] = [];
  let position = eventPosition(
    old ?? { recording_id: id, ordinal: '0', index: -1 },
    id,
  );
  for (let step = 0; step < 64; step++) {
    const page = await recordingEventPage(
      id,
      position,
      limit,
      f.window,
      () => {},
    );
    assert(page.data.length <= limit);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
    result.push(...page.data);
    if (!page.next_cursor) return { result, cursors, windows: f.count() };
    assert(!cursors.includes(page.next_cursor), 'Cursor must advance');
    cursors.push(page.next_cursor);
    position = eventPosition(
      JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString()),
      id,
    );
  }
  throw new Error('Fixture pagination stalled');
}
const event = (value: string) => ({
  event_id: value,
  event_type: 'test',
  event: { value },
});

test('pose-only windows return empty continuation then later events without rescan or lost bytes', async () => {
  const identity = {
    recording_id: id,
    session_id: id,
    lease_id: id,
    epoch: '1',
  } as RecordingIdentity;
  const frame = Buffer.alloc(632);
  frame.write('LWM1');
  frame.writeBigUInt64LE(1n, 16);
  const packet = sourcePacket(identity, 1, 1n, frameBatch([frame])).bytes;
  const parts = [
    [row(1, 'source.packet', { packet_base64: packet.toString('base64') })],
    [row(2, 'source.packet', { packet_base64: packet.toString('base64') })],
    [row(3, 'business.event', event('tail'))],
  ];
  const f = fixture(parts);
  const first = await recordingEventPage(
    id,
    eventPosition({ recording_id: id, ordinal: '0', index: -1 }, id),
    1,
    f.window,
    () => {},
  );
  assert.deepEqual(first.data, []);
  assert(first.next_cursor);
  const all = await collect(parts);
  assert.deepEqual(
    all.result.map((r) => r.event_id),
    ['tail'],
  );
  assert.equal(all.windows, 3);
  const corrupt = Buffer.from(packet);
  corrupt[corrupt.length - 1] ^= 1;
  const journal = decodeJournalBytes(
    encodeJournalRecord(
      row(1, 'source.packet', { packet_base64: corrupt.toString('base64') }),
    ),
  );
  await assert.rejects(() => collect([journal]));
});

test('embedded multi-event commit splits pages without skip/duplicate; prepare and abort are not events', async () => {
  const events = [event('a'), event('b'), event('c')];
  const sha256 = journalDigest(Buffer.from(JSON.stringify(events)));
  const all = await collect([
    [
      row(1, 'business.prepare', { batch_id: 'batch', events, sha256 }),
      row(2, 'business.abort', { batch_id: 'other' }),
      row(3, 'business.commit', { batch_id: 'batch', events, sha256 }),
    ],
  ]);
  assert.deepEqual(
    all.result.map((r) => r.event_id),
    ['a', 'b', 'c'],
  );
  assert.equal(new Set(all.result.map((r) => r.event_id)).size, 3);
});

test('old event cursor uses bounded prefix continuation and retains its within-batch index', async () => {
  const events = [event('old'), event('new')];
  const sha256 = journalDigest(Buffer.from(JSON.stringify(events)));
  const all = await collect(
    [
      [row(1, 'business.event', event('prefix'))],
      [row(2, 'business.commit', { events, sha256 })],
      [row(3, 'business.event', event('appended'))],
    ],
    1,
    { recording_id: id, ordinal: '2', index: 0 },
  );
  assert.deepEqual(
    all.result.map((r) => r.event_id),
    ['new', 'appended'],
  );
});

test('legacy prepare/abort/commit across segment boundaries remains witnessed and cursor-bounded', async () => {
  const events = [event('legacy-a'), event('legacy-b')];
  const sha256 = journalDigest(Buffer.from(JSON.stringify(events)));
  const prepare = row(1, 'business.prepare', {
    batch_id: 'legacy',
    events,
    sha256,
  });
  const commit = row(4, 'business.commit', { batch_id: 'legacy', sha256 });
  const all = await collect([
    [prepare],
    [row(2, 'header', {})],
    [row(3, 'header', {})],
    [commit],
  ]);
  assert.deepEqual(
    all.result.map((r) => r.event_id),
    ['legacy-a', 'legacy-b'],
  );
  const fallback = await collect([
    [prepare],
    [row(2, 'header', {})],
    [
      row(4, 'business.commit', {
        batch_id: 'legacy',
        sha256,
        events: [event('changed')],
      }),
    ],
  ]);
  assert.deepEqual(
    fallback.result.map((r) => r.event_id),
    ['legacy-a', 'legacy-b'],
  );
  const aborted = await collect([
    [prepare],
    [row(2, 'business.abort', { batch_id: 'legacy' })],
    [commit],
  ]);
  assert.deepEqual(aborted.result, []);
});

test('last-page continuation can read later append and rejects wrong Recording cursor', async () => {
  const f = fixture([
    [row(1, 'business.event', event('first'))],
    [row(2, 'header', {})],
  ]);
  const first = await recordingEventPage(
    id,
    eventPosition({ recording_id: id, ordinal: '0', index: -1 }, id),
    1,
    f.window,
    () => {},
  );
  assert(first.next_cursor);
  const position = eventPosition(
    JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString()),
    id,
  );
  const appended = await recordingEventPage(
    id,
    position,
    1,
    fixture([
      [row(1, 'business.event', event('first'))],
      [row(2, 'header', {}), row(3, 'business.event', event('later'))],
    ]).window,
    () => {},
  );
  assert.deepEqual(
    appended.data.map((r) => r.event_id),
    ['later'],
  );
  assert.equal(appended.next_cursor, null);
  assert.throws(() =>
    eventPosition({ ...position, recording_id: 'foreign' }, id),
  );
});
