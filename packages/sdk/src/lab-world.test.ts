import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import {
  createApiClient,
  subscribeLabWorld,
  listLabs,
  streamLabWorld,
} from './index';

test('a subscription survives the ordinary request deadline and releases the stream on cancellation', async () => {
  let send!: (event: unknown) => void;
  let requestSignal: AbortSignal | undefined;
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const stream = new ReadableStream({
    start(controller) {
      send = (event) =>
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        );
    },
  });
  server.use(
    http.get('http://api.test/api/v1/lab/labs', async () => {
      await requestGate;
      return HttpResponse.json({ data: [] });
    }),
    http.get(
      'http://api.test/api/v1/lab/labs/shared/world/subscribe',
      ({ request }) => {
        requestSignal = request.signal;
        expect(request.headers.get('authorization')).toBe('Bearer agent-key');
        return new HttpResponse(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    ),
  );
  const abort = new AbortController();
  const received: unknown[] = [];
  let ready!: () => void;
  const connected = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const client = createApiClient('http://api.test', { timeoutMs: 1 });
  const done = subscribeLabWorld({
    client,
    labId: 'shared',
    headers: { authorization: 'Bearer agent-key' },
    signal: abort.signal,
    onEvent: (event) => {
      received.push(event);
      ready();
    },
  });
  send({ type: 'heartbeat', version: '1' });
  await connected;
  await expect(listLabs({ client, throwOnError: true })).rejects.toThrow();
  releaseRequest();
  let second!: () => void;
  const secondEvent = new Promise<void>((resolve) => {
    second = resolve;
  });
  ready = second;
  send({ type: 'heartbeat', version: '2' });
  await secondEvent;
  abort.abort();
  await done;
  expect(requestSignal?.aborted).toBe(true);
  expect(received[0]).toEqual({ type: 'heartbeat', version: '1' });
});

test('a missing update base requests resynchronization without publishing partial facts', async () => {
  const world = {
    version: '1',
    lab: { id: 'shared' },
    entities: [],
    nodes: [],
    assets: [],
    relationships: [],
  };
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/shared/world/subscribe',
      () =>
        new HttpResponse(
          `data: ${JSON.stringify({ type: 'snapshot', world })}\n\ndata: ${JSON.stringify({ type: 'update', version: '3', base_version: '2', lab: null, changes: [] })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
  const worlds: unknown[] = [];
  await expect(
    subscribeLabWorld({
      client: createApiClient('http://api.test'),
      labId: 'shared',
      signal: new AbortController().signal,
      onWorld: (world) => worlds.push(world),
    }),
  ).rejects.toMatchObject({ reason: 'version_gap' });
  expect(worlds).toEqual([world]);
});

test('the generated SSE operation uses a stream lifetime independent of the ordinary deadline', async () => {
  let send!: () => void;
  let streamSignal: AbortSignal | undefined;
  const stream = new ReadableStream({
    start(controller) {
      send = () =>
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"heartbeat","version":"1"}\n\n',
          ),
        );
    },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/shared/world/subscribe',
      ({ request }) => {
        streamSignal = request.signal;
        return new HttpResponse(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    ),
    http.get('http://api.test/api/v1/lab/labs', async () => {
      await gate;
      return HttpResponse.json({ data: [] });
    }),
  );
  const client = createApiClient('http://api.test', { timeoutMs: 1 });
  const abort = new AbortController();
  const result = await streamLabWorld({
    client,
    path: { lab_id: 'shared' },
    signal: abort.signal,
    sseMaxRetryAttempts: 1,
    onSseError(error) {
      if (!abort.signal.aborted) throw error;
    },
  });
  try {
    send();
    expect((await result.stream.next()).value).toEqual({
      type: 'heartbeat',
      version: '1',
    });
    await expect(listLabs({ client, throwOnError: true })).rejects.toThrow();
    expect(streamSignal?.aborted).toBe(false);
    release();
    send();
    expect((await result.stream.next()).value).toEqual({
      type: 'heartbeat',
      version: '1',
    });
  } finally {
    release();
    abort.abort();
    await result.stream.return();
  }
});

test('an unfinished oversized SSE frame is rejected within the public payload bound', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/shared/world/subscribe',
      () =>
        new HttpResponse('data: ' + 'x'.repeat(1024 * 1024 + 65), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
  );
  await expect(
    subscribeLabWorld({
      client: createApiClient('http://api.test'),
      labId: 'shared',
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ reason: 'payload_limit' });
});
