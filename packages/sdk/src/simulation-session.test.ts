import { http, HttpResponse } from 'msw';
import { expect, test, vi } from 'vitest';
import { server } from '../../../tests/frontend/server';
import {
  sessionWorld,
  simulationSession,
} from '../../../tests/frontend/session-fixture';
import {
  motionWelcome,
  motionSnapshot,
} from '../../../tests/frontend/motion-fixture';
import { encodeMotionSnapshot } from '@labos-threejs/contracts/motion';
import {
  createApiClient,
  projectSessionWorld,
  subscribeSimulationSessions,
  subscribeSessionMotion,
  type MotionTransportAdapter,
} from './index';

test('Session rendering fixes mapped geometry and Placement while retaining live facts and unrelated Lab nodes', () => {
  const current = structuredClone(sessionWorld);
  current.version = '3';
  current.nodes[0].placement.position = [8, 9, 10];
  current.nodes[0].placement.scale = [2, 2, 2];
  current.nodes[0].representation_id = 'new-representation';
  current.entities[0].name = 'Live renamed object';
  current.entities[0].definition_id = 'lamp';
  current.entities[0].representation_id = 'new-representation';
  current.nodes.push({
    ...current.nodes[0],
    id: 'unrelated-node',
    entity_id: 'unrelated-entity',
  });
  current.entities.push({ ...current.entities[0], id: 'unrelated-entity' });
  const projected = projectSessionWorld(current, simulationSession.snapshot);
  expect(
    projected.nodes.find((node) => node.id === sessionWorld.nodes[0].id),
  ).toEqual(sessionWorld.nodes[0]);
  expect(projected.entities[0].definition_id).toBe('robot');
  expect(projected.entities[0].name).toBe('Live renamed object');
  expect(projected.nodes.find((node) => node.id === 'unrelated-node')).toBe(
    current.nodes[1],
  );
  expect(projected.entities[1]).toBe(current.entities[1]);
  expect(current.nodes[0].placement.position).toEqual([8, 9, 10]);
  expect(simulationSession.snapshot.world.nodes[0].placement.position).toEqual([
    1, 2, 3,
  ]);
  // Stop consumes current directly; Reset consumes the original immutable snapshot.
  expect(current.nodes[0].representation_id).toBe('new-representation');
  expect(
    projectSessionWorld(current, simulationSession.snapshot).nodes.at(-1)
      ?.representation_id,
  ).toBe('fixed-representation');
});

test('authenticated Session events preserve scope and cancellation closes the dedicated lifecycle stream', async () => {
  const abort = new AbortController();
  const ready = vi.fn();
  let requestSignal: AbortSignal | undefined;
  const onSession = vi.fn(() => abort.abort());
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/shared/sessions/events',
      ({ request }) => {
        requestSignal = request.signal;
        expect(request.credentials).toBe('include');
        return new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'session', session: simulationSession })}\n\n`,
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    ),
  );
  await subscribeSimulationSessions({
    client: createApiClient('http://api.test'),
    labId: 'shared',
    signal: abort.signal,
    onReady: ready,
    onSession,
  });
  expect(ready).toHaveBeenCalledOnce();
  expect(onSession).toHaveBeenCalledWith({
    type: 'session',
    session: simulationSession,
  });
  expect(requestSignal?.aborted).toBe(true);
});

test('Session events reject another Lab before delivery', async () => {
  const onSession = vi.fn();
  server.use(
    http.get(
      'http://api.test/api/v1/lab/labs/shared/sessions/events',
      () =>
        new HttpResponse(
          `data: ${JSON.stringify({ type: 'session', session: { ...simulationSession, lab_id: 'another-lab' } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
  await expect(
    subscribeSimulationSessions({
      client: createApiClient('http://api.test'),
      labId: 'shared',
      signal: new AbortController().signal,
      onSession,
    }),
  ).rejects.toMatchObject({ reason: 'wrong_lab' });
  expect(onSession).not.toHaveBeenCalled();
});

test('a successor Session obtains a fresh scoped ticket and obsolete transport callbacks cannot deliver old frames', async () => {
  const admitted: string[] = [];
  const callbacks: Parameters<MotionTransportAdapter>[1][] = [];
  const dispose = vi.fn();
  const close = vi.fn();
  const transport: MotionTransportAdapter = (_url, handlers) => {
    callbacks.push(handlers);
    return { send() {}, dispose, close };
  };
  server.use(
    http.post(
      'http://api.test/api/v1/lab/labs/shared/sessions/:session/viewer-tickets',
      async ({ request, params }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf-session');
        expect(await request.json()).toEqual({ preferred_rate_hz: 15 });
        admitted.push(String(params.session));
        return HttpResponse.json({
          ticket: 'session_scoped_ticket_12345',
          expires_in_seconds: 30,
          websocket_path: `/api/v1/lab/motion/sessions/${params.session}/viewer`,
        });
      },
    ),
  );
  const snapshots = vi.fn();
  const run = (id: string, abort: AbortController) =>
    subscribeSessionMotion({
      client: createApiClient('http://api.test'),
      labId: 'shared',
      sessionId: id,
      sceneHash: motionWelcome.scene_hash,
      rateHz: 15,
      signal: abort.signal,
      headers: { 'x-csrf-token': 'csrf-session' },
      transport,
      onWelcome() {},
      onSnapshot: snapshots,
    });
  const old = new AbortController();
  const first = run(motionWelcome.session_id, old);
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  callbacks[0].message(JSON.stringify(motionWelcome));
  old.abort();
  await first;
  const successor = new AbortController();
  const second = run('10000000-0000-0000-0000-000000000002', successor);
  await vi.waitFor(() => expect(callbacks).toHaveLength(2));
  callbacks[0].message(
    Uint8Array.from(encodeMotionSnapshot(motionSnapshot())).buffer,
  );
  expect(snapshots).not.toHaveBeenCalled();
  callbacks[1].message(
    JSON.stringify({
      ...motionWelcome,
      session_id: '10000000-0000-0000-0000-000000000002',
      epoch: '2',
    }),
  );
  callbacks[1].message(
    Uint8Array.from(
      encodeMotionSnapshot(
        motionSnapshot({ epoch: 2n, sequence: 1n, sim_time_ns: 0n }),
      ),
    ).buffer,
  );
  expect(snapshots).toHaveBeenCalledOnce();
  expect(admitted).toEqual([motionWelcome.session_id, '10000000-0000-0000-0000-000000000002']);
  successor.abort();
  await second;
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});
