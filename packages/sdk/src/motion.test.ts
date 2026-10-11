import { http, HttpResponse } from 'msw';
import { expect, test, vi } from 'vitest';
import { server } from '../../../tests/frontend/server';
import {
  motionWelcome,
  motionSnapshot,
} from '../../../tests/frontend/motion-fixture';
import { encodeMotionSnapshot } from '@labos-threejs/contracts/motion';
import {
  createApiClient,
  subscribeMotion,
  type MotionTransportAdapter,
} from './index';

function setup() {
  const sent: string[] = [];
  const close = vi.fn();
  const dispose = vi.fn();
  let callbacks!: Parameters<MotionTransportAdapter>[1];
  const transport = vi.fn<MotionTransportAdapter>((url, handlers) => {
    expect(url).toBe(
      `ws://api.test/api/v1/lab/motion/sessions/${motionWelcome.session_id}/viewer`,
    );
    callbacks = handlers;
    return { send: (value) => sent.push(value), close, dispose };
  });
  server.use(
    http.post(
      `http://api.test/api/v1/lab/labs/shared/motion-fixture/${motionWelcome.session_id}/viewer-tickets`,
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf-motion');
        expect(request.credentials).toBe('include');
        expect(await request.json()).toEqual({ preferred_rate_hz: 30 });
        return HttpResponse.json({
          ticket: 'scoped_ticket_123456789',
          expires_in_seconds: 30,
          websocket_path: `/api/v1/lab/motion/sessions/${motionWelcome.session_id}/viewer`,
        });
      },
    ),
  );
  const abort = new AbortController();
  const onWelcome = vi.fn();
  const onSnapshot = vi.fn();
  const done = subscribeMotion({
    client: createApiClient('http://api.test'),
    labId: 'shared',
    sessionId: motionWelcome.session_id,
    sceneHash: motionWelcome.scene_hash,
    rateHz: 30,
    headers: { 'x-csrf-token': 'csrf-motion' },
    signal: abort.signal,
    transport,
    onWelcome,
    onSnapshot,
  });
  // Observe failures immediately even when rejection happens synchronously in a callback.
  void done.catch(() => {});
  return {
    ready: async () => {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
      return callbacks;
    },
    done,
    abort,
    close,
    dispose,
    sent,
    onWelcome,
    onSnapshot,
  };
}
const binary = (snapshot = motionSnapshot()) =>
  Uint8Array.from(encodeMotionSnapshot(snapshot)).buffer;

test('scoped admission precedes WELCOME and full snapshots; cancellation releases transport and callbacks', async () => {
  const connection = setup();
  const events = await connection.ready();
  events.open();
  expect(JSON.parse(connection.sent[0])).toMatchObject({
    role: 'viewer',
    ticket: 'scoped_ticket_123456789',
    preferred_rate_hz: 30,
  });
  events.message(JSON.stringify(motionWelcome));
  events.message(binary());
  expect(connection.onWelcome).toHaveBeenCalledOnce();
  expect(connection.onSnapshot.mock.calls[0][0].sequence).toBe(
    9007199254740993n,
  );
  expect(connection.onSnapshot.mock.calls[0][1]).toBeTypeOf('number');
  connection.abort.abort();
  await connection.done;
  expect(connection.close).toHaveBeenCalledOnce();
  expect(connection.dispose).toHaveBeenCalledOnce();
  events.message(binary());
  expect(connection.onSnapshot).toHaveBeenCalledOnce();
});

test('binary before WELCOME is refused without exposing a snapshot', async () => {
  const connection = setup();
  const events = await connection.ready();
  events.message(binary());
  await expect(connection.done).rejects.toMatchObject({
    reason: 'welcome_required',
  });
  expect(connection.onSnapshot).not.toHaveBeenCalled();
  expect(connection.dispose).toHaveBeenCalledOnce();
});

test('duplicate sequence and old epoch are refused; a new trusted epoch permits a fresh sequence', async () => {
  const connection = setup();
  const events = await connection.ready();
  events.message(JSON.stringify(motionWelcome));
  events.message(binary());
  const epoch = BigInt(motionWelcome.epoch) + 1n;
  events.message(JSON.stringify({ ...motionWelcome, epoch: epoch.toString() }));
  events.message(binary(motionSnapshot({ epoch, sequence: 1n })));
  expect(connection.onSnapshot).toHaveBeenCalledTimes(2);
  events.message(binary(motionSnapshot({ epoch, sequence: 1n })));
  await expect(connection.done).rejects.toMatchObject({
    reason: 'sequence_regression',
  });
  const other = setup();
  const otherEvents = await other.ready();
  otherEvents.message(
    JSON.stringify({ ...motionWelcome, epoch: epoch.toString() }),
  );
  otherEvents.message(binary());
  await expect(other.done).rejects.toMatchObject({ code: 'epoch_mismatch' });
  expect(other.onSnapshot).not.toHaveBeenCalled();
});

test('same or regressed metadata cannot reset a sequence fence', async () => {
  const connection = setup();
  const events = await connection.ready();
  events.message(JSON.stringify(motionWelcome));
  events.message(binary());
  events.message(JSON.stringify(motionWelcome));
  await expect(connection.done).rejects.toMatchObject({
    reason: 'metadata_regression',
  });
});

test('a closed control terminates the transport and releases listeners', async () => {
  const connection = setup();
  const events = await connection.ready();
  events.message(JSON.stringify(motionWelcome));
  events.message(
    JSON.stringify({ type: 'motion.status', state: 'closed', rate_hz: 30 }),
  );
  await expect(connection.done).rejects.toMatchObject({
    reason: 'session_closed',
  });
  expect(connection.dispose).toHaveBeenCalledOnce();
  expect(connection.close).toHaveBeenCalledOnce();
});

test('failed HTTP admission never opens a motion transport', async () => {
  const transport = vi.fn<MotionTransportAdapter>();
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/denied/motion-fixture/:session/viewer-tickets',
      () => HttpResponse.json({ code: 'auth.unauthorized' }, { status: 401 }),
    ),
  );
  await expect(
    subscribeMotion({
      client: createApiClient('http://api.test'),
      labId: 'denied',
      sessionId: motionWelcome.session_id,
      sceneHash: motionWelcome.scene_hash,
      rateHz: 15,
      signal: new AbortController().signal,
      transport,
      onWelcome: vi.fn(),
      onSnapshot: vi.fn(),
    }),
  ).rejects.toEqual({ code: 'auth.unauthorized' });
  expect(transport).not.toHaveBeenCalled();
});
