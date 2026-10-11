import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreHttp } from './core-http.ts';
import { captureRecordingReadFailure } from './recording-read-receipt.ts';

const path =
  '/api/v1/lab/labs/00000000-0000-4000-8000-000000000001/recordings/00000000-0000-4000-8000-000000000002/events?cursor=private';

test('capture retains only safe code and leaves the original response readable', async () => {
  const body = {
    error: {
      code: 'lab.recording_read_timeout',
      message: 'private message',
      request_id: 'private identity',
      details: { secret: 'private body' },
    },
  };
  const response = Response.json(body, { status: 409 });
  let saved = '';
  await captureRecordingReadFailure(
    response,
    'GET',
    path,
    200,
    '/owned/receipt.json',
    'current-nonce',
    (_, receipt) => {
      saved = receipt;
    },
  );
  const receipt = JSON.parse(saved);
  assert.equal(receipt.code, body.error.code);
  assert.equal(receipt.status, 409);
  assert.equal(receipt.valid, true);
  assert(!saved.includes('private'));
  assert.deepEqual(await response.json(), body);
});

test('disabled and successful responses perform no clone or persistence', async () => {
  const response = new Response('{}');
  response.clone = () => {
    throw new Error('must not clone');
  };
  const publish = () => {
    throw new Error('must not persist');
  };
  await captureRecordingReadFailure(
    response,
    'GET',
    path,
    200,
    '',
    '',
    publish,
  );
  await captureRecordingReadFailure(
    response,
    'GET',
    path,
    200,
    '/owned/receipt.json',
    'current-nonce',
    publish,
  );
});

test('persistence failure latches and the original HTTP status assertion still fails', async () => {
  const response = Response.json(
    { error: { code: 'lab.recording_read_timeout' } },
    { status: 409 },
  );
  await captureRecordingReadFailure(
    response,
    'GET',
    path,
    200,
    '/owned/receipt.json',
    'current-nonce',
    () => {
      throw new Error('owned write failure');
    },
  );
  let laterWrites = 0;
  await captureRecordingReadFailure(
    response,
    'GET',
    path,
    200,
    '/owned/receipt.json',
    'current-nonce',
    () => {
      laterWrites++;
    },
  );
  assert.equal(laterWrites, 0);
  const api = new CoreHttp('http://owned.invalid');
  api.response = async () => response;
  await assert.rejects(api.json('GET', path), {
    name: 'AssertionError',
    actual: 409,
    expected: 200,
  });
  assert.equal(
    (await response.json()).error.code,
    'lab.recording_read_timeout',
  );
});
