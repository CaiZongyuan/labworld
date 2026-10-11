import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventWindow,
  type EventPart,
} from '../../packages/server/src/lab/recordings/event-window.ts';
import {
  decodeJournalBytes,
  encodeJournalRecord,
} from '../../packages/server/src/lab/recordings/journal.ts';

test('large history reads one ordinal-next segment and only two exact points; corrupt bytes remain failures', async () => {
  const bytes = Array.from({ length: 1000 }, (_, i) =>
    encodeJournalRecord({
      ordinal: String(i + 1),
      kind: 'header',
      recorded_at: '2026-10-11T00:00:00Z',
      data: {},
    }),
  );
  const parts: EventPart[] = bytes.map((b, i) => ({
    id: String(i),
    index: i,
    size: b.length,
    first_ordinal: String(i + 1),
    last_ordinal: String(i + 1),
    file_id: String(i),
    path: null,
  }));
  const reads: number[] = [];
  const page = await eventWindow('900', parts, async (part) => {
    reads.push(part.index);
    return decodeJournalBytes(bytes[part.index]);
  });
  assert.deepEqual(reads, [900]);
  assert.equal(page.records[0].ordinal, '901');
  await page.at('1');
  await page.at('1000');
  assert.deepEqual(reads, [900, 0, 999]);
  await page.at('1');
  assert.equal(reads.length, 3);
  await assert.rejects(() => page.at('2'), /recording_event_window_capacity/);
  const bad = Buffer.from(bytes[900]);
  bad[bad.length - 1] ^= 1;
  await assert.rejects(
    () => eventWindow('900', parts, async () => decodeJournalBytes(bad)),
    /recording_corrupt_tail/,
  );
});

test('confirmed local-prefix window can grow later without exposing an unconfirmed suffix', async () => {
  const first = encodeJournalRecord({
    ordinal: '1',
    kind: 'header',
    recorded_at: 'now',
    data: {},
  });
  const next = encodeJournalRecord({
    ordinal: '2',
    kind: 'header',
    recorded_at: 'now',
    data: {},
  });
  const part: EventPart = {
    id: 'local',
    index: 0,
    size: first.length,
    first_ordinal: '1',
    last_ordinal: '1',
    file_id: null,
    path: 'owned',
  };
  const physical = Buffer.concat([first, next]);
  const old = await eventWindow('0', [part], async (p) =>
    decodeJournalBytes(physical.subarray(0, p.size)),
  );
  assert.deepEqual(
    old.records.map((r) => r.ordinal),
    ['1'],
  );
  const grown = await eventWindow(
    '1',
    [{ ...part, size: physical.length, last_ordinal: '2' }],
    async (p) => decodeJournalBytes(physical.subarray(0, p.size)),
  );
  assert.deepEqual(
    grown.records.map((r) => r.ordinal),
    ['2'],
  );
});
