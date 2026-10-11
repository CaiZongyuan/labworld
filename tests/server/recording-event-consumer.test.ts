import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordingEventCursors } from '../../packages/server/src/lab/recordings/event-cursor.ts';
import { eventPosition } from '../../packages/server/src/lab/recordings/event-page.ts';
import { recordingEvents } from '../e2e/recording-public-support.ts';
import type { CoreHttp } from '../support/core-http.ts';
const id = '10000000-0000-0000-0000-000000000001';
const codec = new RecordingEventCursors(Buffer.alloc(32, 3));
const continuation = (scan: number) =>
  codec.encode(
    eventPosition(
      { recording_id: id, ordinal: '0', index: -1, scan: String(scan) },
      id,
    ),
  );

test('actual complete-event consumer follows more than64 empty signed scan pages to an event', async () => {
  let requests = 0;
  const api = {
    json: async () => {
      requests++;
      return requests <= 80
        ? { data: [], next_cursor: continuation(requests) }
        : { data: [{ event_id: 'tail' }], next_cursor: null };
    },
  } as unknown as CoreHttp;
  const events = await recordingEvents(api, '/recording');
  assert.deepEqual(
    events.map((e) => e.event_id),
    ['tail'],
  );
  assert.equal(requests, 81);
});
test('actual event consumer rejects a stalled/cycling physical continuation without growing a cursor cache', async () => {
  const api = {
    json: async () => ({ data: [], next_cursor: continuation(1) }),
  } as unknown as CoreHttp;
  await assert.rejects(
    recordingEvents(api, '/recording'),
    /must make progress/,
  );
});
