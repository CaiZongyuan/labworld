import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createClient } from './generated/client';
import { readRecordingSegment } from './recording';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const content = new TextEncoder().encode('a verified finite segment');
const segment = {
  id: '10000000-0000-0000-0000-000000000001',
  index: 0,
  file_id: '10000000-0000-0000-0000-000000000002',
  sealed: true,
  size: content.byteLength,
  sha256: 'sha256:' + createHash('sha256').update(content).digest('hex'),
  first_ordinal: '1',
  last_ordinal: '1',
};
const options = (response: Response) => ({
  client: createClient({
    baseUrl: 'http://api.test',
    credentials: 'include',
    fetch: vi.fn(async () => response),
  }),
  labId: 'lab',
  recordingId: 'recording',
  segment,
});

test('reads exactly one sealed segment, verifies its bytes and forwards authentication and scope', async () => {
  const fetch = vi.fn(async (request: Request) => {
    expect(request.url).toBe(
      'http://api.test/api/v1/lab/labs/lab/recordings/recording/segments/' +
        segment.id,
    );
    expect(request.credentials).toBe('include');
    expect(request.headers.get('authorization')).toBe('Bearer scoped-key');
    return new Response(
      new ReadableStream({
        start(target) {
          target.enqueue(content.subarray(0, 3));
          target.enqueue(content.subarray(3));
          target.close();
        },
      }),
      {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(content.byteLength),
        },
      },
    );
  });
  const result = await readRecordingSegment({
    ...options(new Response()),
    client: createClient({
      baseUrl: 'http://api.test',
      credentials: 'include',
      fetch: fetch as typeof globalThis.fetch,
    }),
    headers: { authorization: 'Bearer scoped-key' },
  });
  expect(Array.from(result)).toEqual(Array.from(content));
  expect(fetch).toHaveBeenCalledOnce();
});

test('rejects open or oversized segments before requesting content', async () => {
  const input = options(new Response(content));
  await expect(
    readRecordingSegment({ ...input, segment: { ...segment, sealed: false } }),
  ).rejects.toThrow('sealed');
  await expect(
    readRecordingSegment({
      ...input,
      segment: { ...segment, size: 1024 * 1024 + 1 },
    }),
  ).rejects.toThrow('limit');
  expect(input.client.getConfig().fetch).not.toHaveBeenCalled();
});

test('rejects excess bytes before copying and cancels the remaining stream', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(target) {
      target.enqueue(new Uint8Array(segment.size + 1));
    },
    cancel,
  });
  await expect(
    readRecordingSegment(options(new Response(stream))),
  ).rejects.toThrow('exceeds');
  expect(cancel).toHaveBeenCalledOnce();
});

test('rejects truncation or changed content rather than returning a partial segment', async () => {
  await expect(
    readRecordingSegment(options(new Response(content.subarray(1)))),
  ).rejects.toThrow('truncated');
  const altered = content.slice();
  altered[0] ^= 1;
  await expect(
    readRecordingSegment(options(new Response(altered))),
  ).rejects.toThrow('SHA-256');
});

test('caller abort cancels a blocked segment reader and releases its stream', async () => {
  const cancel = vi.fn(),
    abort = new AbortController();
  const response = new Response(new ReadableStream({ cancel }));
  const reading = readRecordingSegment({
    ...options(response),
    signal: abort.signal,
  });
  await vi.waitFor(() => expect(response.body?.locked).toBe(true));
  abort.abort(new Error('reader stopped'));
  await expect(reading).rejects.toThrow('reader stopped');
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});
