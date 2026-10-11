import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventReader } from '../support/session-event-reader.ts';

const id = '10000000-0000-0000-0000-000000000001';
const event = (revision: number, status: 'running' | 'pausing' | 'paused') => ({
  type: 'session',
  session: { id, revision, status, marker: '安全' },
});
const block = (value: ReturnType<typeof event>) =>
  'data: ' + JSON.stringify(value) + '\n\n';
function reader(chunks: Uint8Array[]) {
  return new SessionEventReader(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }).getReader(),
  );
}

test('persistent lifecycle reader retains coalesced events, skips an earlier revision and decodes split UTF-8 bytes', async () => {
  const bytes = Buffer.from(
    ': ready\n\n' +
      block(event(2, 'running')) +
      block(event(2, 'running')) +
      block(event(3, 'pausing')) +
      block(event(4, 'paused')),
  );
  const split = bytes.indexOf(Buffer.from('安全')) + 1;
  const stream = reader([bytes.subarray(0, split), bytes.subarray(split)]);
  assert.deepEqual(await stream.next(), event(2, 'running'));
  assert.deepEqual(
    await stream.receive({ id, revision: 3, status: 'pausing' }),
    event(3, 'pausing'),
  );
  assert.deepEqual(await stream.next(), event(4, 'paused'));
  assert.equal(await stream.next(), undefined);
});

test('an exact lifecycle revision cannot be replaced by a later event', async () => {
  const stream = reader([
    Buffer.from(block(event(2, 'running')) + block(event(4, 'paused'))),
  ]);
  await assert.rejects(
    stream.receive({ id, revision: 3, status: 'pausing' }),
    /Requested Session revision skipped/,
  );
});

test('lifecycle observation refuses the wrong status at the requested revision and an early closed stream', async () => {
  const wrong = reader([Buffer.from(block(event(3, 'paused')))]);
  await assert.rejects(
    wrong.receive({ id, revision: 3, status: 'pausing' }),
    /Requested Session status changed/,
  );
  const closed = reader([Buffer.from(block(event(2, 'running')))]);
  await assert.rejects(
    closed.receive({ id, revision: 3, status: 'pausing' }),
    /Lifecycle stream closed before requested revision/,
  );
});
