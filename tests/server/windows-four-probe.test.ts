import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreHttp } from '../support/core-http.ts';
import {
  failedHttpCode,
  observedWindowsHttp,
  receiveCode,
  safeSession,
} from '../support/windows-four-probe.ts';

const before = {
  status: 'starting',
  revision: 0,
  lease_id: null,
  epoch: null,
  ended_at: null,
};

test('Windows probe projects only finite codes and session facts', () => {
  assert.equal(
    receiveCode({ code: 'lab.recording_ack_timeout', message: 'private' }),
    'lab.recording_ack_timeout',
  );
  assert.equal(receiveCode({ code: 'private' }), 'UNKNOWN');
  assert.deepEqual(
    safeSession({
      ...before,
      status: 'private',
      revision: 'private',
      epoch: 'private',
      lease_id: 'private',
    }),
    {
      status: 'UNKNOWN',
      revision: null,
      leaseNull: false,
      epochString: null,
      ended: false,
    },
  );
});

test('Windows failed-response projection cancels a stalled stream and rejects oversized or unknown data', async () => {
  let cancelled = false;
  const stalled = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 503 },
  );
  const result = await failedHttpCode(stalled, 201, 5);
  assert.equal(result.status, 'timeout');
  assert.equal(result.code, 'UNKNOWN');
  assert.equal(cancelled, true);
  assert.equal(
    (
      await failedHttpCode(
        new Response('x'.repeat(4097), { status: 503 }),
        201,
        100,
      )
    ).status,
    'size-limit',
  );
  assert.equal(
    (
      await failedHttpCode(
        new Response(
          JSON.stringify({ error: { code: 'private', message: 'private' } }),
          { status: 503 },
        ),
        201,
        100,
      )
    ).code,
    'UNKNOWN',
  );
});

test('Windows observation preserves original assertion identity and the response descriptor; success leaves body unread', async () => {
  const previous = process.env.LAB_WORLD_WINDOWS_PROBE;
  const directory = await mkdtemp(join(tmpdir(), 'windows-four-pure-'));
  try {
    process.env.LAB_WORLD_WINDOWS_PROBE = '1';
    const client = new CoreHttp('http://unused.invalid');
    client.response = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'lab.recording_gate_timeout',
            message: 'PRIVATE_SENTINEL',
          },
        }),
        { status: 503 },
      );
    const descriptor = Object.getOwnPropertyDescriptor(client, 'response');
    let original: unknown;
    await assert.rejects(
      observedWindowsHttp(
        client,
        async () => {
          try {
            return await client.json('POST', '/original', {}, 201);
          } catch (error) {
            original = error;
            throw error;
          }
        },
        201,
        before,
        directory,
        'task-initial-admission',
        performance.now() + 1000,
      ),
      (error) => error === original,
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(client, 'response'),
      descriptor,
    );
    const bytes = await readFile(
      join(directory, 'windows-task-admission.json'),
      'utf8',
    );
    assert(!bytes.includes('PRIVATE_SENTINEL'));
    assert.equal(JSON.parse(bytes).body.code, 'lab.recording_gate_timeout');
    const success = new Response('PRIVATE_SENTINEL', { status: 200 });
    client.response = async () => success;
    const value = await observedWindowsHttp(
      client,
      async () => {
        const response = await client.response('POST', '/original');
        assert.equal(response.status, 200);
        return 17;
      },
      200,
      before,
      directory,
      'formal-machine-pause',
      performance.now() + 1000,
    );
    assert.equal(value, 17);
    assert.equal(success.bodyUsed, false);
    const failure = new Error('original');
    await assert.rejects(
      observedWindowsHttp(
        client,
        async () => {
          throw failure;
        },
        200,
        before,
        directory,
        'formal-machine-pause',
        performance.now() + 1000,
        () => {
          throw new Error('observer');
        },
      ),
      (error) => error === failure,
    );
    process.env.LAB_WORLD_WINDOWS_PROBE = 'off';
    let calls = 0;
    assert.equal(
      await observedWindowsHttp(
        client,
        async () => {
          calls++;
          return 23;
        },
        201,
        before,
        directory,
        'task-initial-admission',
        performance.now(),
      ),
      23,
    );
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.LAB_WORLD_WINDOWS_PROBE;
    else process.env.LAB_WORLD_WINDOWS_PROBE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
