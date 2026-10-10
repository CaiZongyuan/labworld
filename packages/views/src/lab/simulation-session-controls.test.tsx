import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, passthrough } from 'msw';
import { WebSocketServer, WebSocket } from 'ws';
import { expect, onTestFinished, test, vi } from 'vitest';
import { appendFileSync, mkdirSync } from 'node:fs';
import {
  createApiClient,
  type SimulationSession,
  type SceneInstallation,
} from '@labos-threejs/sdk';
import { encodeMotionSnapshot } from '@labos-threejs/contracts/motion';
import { server } from '../../../../tests/frontend/server';
import {
  sessionWorld,
  sessionInstallation,
  simulationSession,
} from '../../../../tests/frontend/session-fixture';
import {
  motionWelcome,
  motionSnapshot,
} from '../../../../tests/frontend/motion-fixture';
import { PreferencesProvider } from '../shell/preferences';
import { AppMessagesProvider } from '../shell/messages';
import { labApp } from './app';
import { useSimulationSession } from './use-simulation-session';
import { SimulationSessionControls } from './simulation-session-controls';

async function openSession({
  installed = true,
  enabled = true,
}: { installed?: boolean; enabled?: boolean } = {}) {
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let unmount = () => {};
  const peers: WebSocket[] = [];
  const subscriptions: {
    signal: AbortSignal;
    controller: ReadableStreamDefaultController<Uint8Array>;
  }[] = [];
  // Observe the actual public fetch signal. MSW clones Requests; its derived
  // signal is not a reliable long-lived cancellation observer after collection.
  const lifecycleSignals: AbortSignal[] = [];
  const fetchRequest = globalThis.fetch;
  const fetchObserver = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) => {
      if (input instanceof Request && input.url.endsWith('/sessions/events'))
        lifecycleSignals.push(init?.signal ?? input.signal);
      return fetchRequest(input, init);
    });
  let release: Promise<void> | undefined;
  const ledgerDirectory = '.scratch/session-viewer-tests';
  mkdirSync(ledgerDirectory, { recursive: true });
  const ledger = `${ledgerDirectory}/owned-resources-${process.pid}.jsonl`;
  const ownedResource: { port?: number } = {};
  const cleanup = () =>
    (release ??= (async () => {
      unmount();
      await Promise.all(
        [...sockets.clients].map(
          (peer) =>
            new Promise<void>((resolve) => {
              if (peer.readyState === WebSocket.CLOSED) {
                resolve();
                return;
              }
              peer.once('close', resolve);
              peer.terminate();
            }),
        ),
      );
      await new Promise<void>((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve())),
      );
      expect(sockets.clients.size).toBe(0);
      expect(lifecycleSignals).toHaveLength(subscriptions.length);
      expect(lifecycleSignals.length).toBeGreaterThan(0);
      expect(lifecycleSignals.map((signal) => signal.aborted)).toEqual(
        lifecycleSignals.map(() => true),
      );
      for (const subscription of subscriptions) {
        try {
          subscription.controller.close();
        } catch {
          /* A cancelled MSW body is already closed. */
        }
      }
      fetchObserver.mockRestore();
      appendFileSync(
        ledger,
        JSON.stringify({
          at: new Date().toISOString(),
          owner: 'session_viewer_71',
          pid: process.pid,
          resource: 'component-test-websocket',
          port: ownedResource.port,
          state: 'released',
          consumers: 0,
        }) + '\n',
      );
      vi.unstubAllGlobals();
    })());
  onTestFinished(cleanup);
  await new Promise<void>((resolve) => sockets.once('listening', resolve));
  const address = sockets.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing owned socket port');
  ownedResource.port = address.port;
  appendFileSync(
    ledger,
    JSON.stringify({
      at: new Date().toISOString(),
      owner: 'session_viewer_71',
      pid: process.pid,
      resource: 'component-test-websocket',
      port: ownedResource.port,
      state: 'created',
      consumers: 'component WS clients in this test worker',
      cleanup:
        'onTestFinished unmount/abort/terminate/close; worker process termination releases its sockets',
    }) + '\n',
  );
  const websocketPath = `http://127.0.0.1:${address.port}/motion`;
  let current: SimulationSession | null = null;
  const installations: SceneInstallation[] = installed
    ? [sessionInstallation]
    : [];
  const requests: { action: string; body: unknown }[] = [];
  let rejection: { code: string; status: number } | null = null;
  const emit = (next: SimulationSession) => {
    current = next;
    for (const subscription of subscriptions) {
      if (!subscription.signal.aborted)
        subscription.controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'session', session: next })}\n\n`,
          ),
        );
    }
  };
  sockets.on('connection', (socket) => {
    peers.push(socket);
    socket.once('message', (data) => {
      const hello = JSON.parse(data.toString()) as {
        session_id: string;
        preferred_rate_hz: 15 | 30;
      };
      expect(hello.session_id).toBe(current?.id);
      socket.send(
        JSON.stringify({
          ...motionWelcome,
          session_id: hello.session_id,
          rate_hz: hello.preferred_rate_hz,
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'motion.status',
          state: current?.status === 'paused' ? 'paused' : 'live',
          rate_hz: hello.preferred_rate_hz,
        }),
      );
      socket.send(encodeMotionSnapshot(motionSnapshot()));
    });
  });
  server.use(
    http.get(websocketPath, () => passthrough()),
    http.get('http://api.test/api/v1/lab/labs/shared/installations', () =>
      HttpResponse.json({ data: installations }),
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/shared/installations',
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf-session');
        expect(await request.json()).toEqual({
          representation_id: 'fixed-representation',
        });
        installations.push(sessionInstallation);
        return HttpResponse.json(sessionInstallation, { status: 201 });
      },
    ),
    http.get('http://api.test/api/v1/lab/labs/shared/sessions', () =>
      HttpResponse.json({
        data: current ? [current] : [],
        active_session_id: current && !current.ended_at ? current.id : null,
        development_synthetic_enabled: enabled,
      }),
    ),
    http.get(
      'http://api.test/api/v1/lab/labs/shared/sessions/events',
      ({ request }) =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              subscriptions.push({ signal: request.signal, controller });
              controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/shared/sessions/:session/viewer-tickets',
      () =>
        HttpResponse.json({
          ticket: 'scoped_ticket_123456789',
          expires_in_seconds: 30,
          websocket_path: websocketPath,
        }),
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/shared/sessions',
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf-session');
        requests.push({ action: 'start', body: await request.json() });
        if (rejection)
          return HttpResponse.json(
            { error: { code: rejection.code } },
            { status: rejection.status },
          );
        current = { ...simulationSession, status: 'starting', revision: 0 };
        return HttpResponse.json(current, { status: 201 });
      },
    ),
    http.post(
      'http://api.test/api/v1/lab/labs/shared/sessions/:session/:action',
      async ({ request, params }) => {
        expect(request.headers.get('x-csrf-token')).toBe('csrf-session');
        expect(params.session).toBe(current?.id);
        const body = await request.json();
        expect(body).toEqual({ expected_revision: current?.revision });
        requests.push({ action: String(params.action), body });
        if (rejection)
          return HttpResponse.json(
            { error: { code: rejection.code } },
            { status: rejection.status },
          );
        current = {
          ...current!,
          revision: current!.revision + 1,
          status:
            params.action === 'pause'
              ? 'pausing'
              : params.action === 'resume'
                ? 'resuming'
                : 'stopping',
        };
        if (params.action === 'reset')
          current = {
            ...current,
            id: '10000000-0000-0000-0000-000000000002',
            status: 'starting',
            revision: 0,
          };
        return HttpResponse.json(current);
      },
    ),
  );
  window.localStorage.setItem('labos-threejs.locale', 'en');
  vi.stubGlobal('WebSocket', WebSocket);
  const client = createApiClient('http://api.test');
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const onInstalled = vi.fn();
  function ConnectedControls() {
    const simulation = useSimulationSession({
      apiClient: client,
      userId: 'operator',
      labId: 'shared',
      csrfToken: 'csrf-session',
      onInstalled,
    });
    return (
      <SimulationSessionControls
        simulation={simulation}
        world={sessionWorld}
        disabled={false}
        startDisabled={false}
      />
    );
  }
  const view = render(
    <QueryClientProvider client={queries}>
      <PreferencesProvider>
        <AppMessagesProvider app={labApp}>
          <ConnectedControls />
        </AppMessagesProvider>
      </PreferencesProvider>
    </QueryClientProvider>,
  );
  unmount = () => {
    view.unmount();
    queries.clear();
  };
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Simulation Session/ }));
  await waitFor(() =>
    expect(screen.getByLabelText('Session lifecycle')).toHaveTextContent(
      'Not started',
    ),
  );
  return {
    user,
    requests,
    peers,
    emit,
    cleanup,
    onInstalled,
    setRejection(value: typeof rejection) {
      rejection = value;
    },
    current: () => current,
  };
}

test('fixed installation and real HTTP controls distinguish accepted transitions from observed shared state; Reset reauthorizes a successor', async () => {
  const fixture = await openSession({ installed: false });
  expect(screen.getByLabelText('Scene Installation')).toHaveTextContent(
    'No fixed scene installed',
  );
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  await fixture.user.click(
    screen.getByRole('button', { name: 'Install fixed scene' }),
  );
  await waitFor(() => expect(fixture.onInstalled).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled(),
  );
  await fixture.user.selectOptions(screen.getByLabelText('Receive rate'), '15');
  await fixture.user.click(screen.getByRole('button', { name: 'Start' }));
  expect(fixture.requests).toEqual([
    { action: 'start', body: { installation_id: sessionInstallation.id } },
  ]);
  await waitFor(() =>
    expect(screen.getByLabelText('Session lifecycle')).toHaveTextContent(
      'Starting',
    ),
  );
  expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
  await act(async () => fixture.emit(simulationSession));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled(),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Motion reception')).toHaveTextContent(
      '15 Hz',
    ),
  );
  await fixture.user.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Session lifecycle')).toHaveTextContent(
      'Pausing',
    ),
  );
  expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
  await act(async () =>
    fixture.emit({ ...fixture.current()!, status: 'paused', revision: 3 }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled(),
  );
  await fixture.user.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Session lifecycle')).toHaveTextContent(
      'Resuming',
    ),
  );
  await act(async () =>
    fixture.emit({ ...fixture.current()!, status: 'running', revision: 5 }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled(),
  );
  await fixture.user.click(screen.getByRole('button', { name: 'Reset' }));
  await waitFor(() =>
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '10000000-0000-0000-0000-000000000002',
    ),
  );
  await waitFor(() => expect(fixture.peers).toHaveLength(2));
  await waitFor(() =>
    expect(fixture.peers[0].readyState).toBe(WebSocket.CLOSED),
  );
  expect(fixture.current()?.snapshot.hash).toBe(
    simulationSession.snapshot.hash,
  );
  await fixture.user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fixture.peers[1].readyState).toBe(WebSocket.OPEN);
  await fixture.cleanup();
});

test.each([
  {
    code: 'lab.session_conflict',
    status: 409,
    text: 'Another operator changed the Session',
  },
  { code: 'auth.csrf', status: 403, text: 'Session access was denied' },
])(
  'a $status refusal leaves selection and saved state unchanged and permits Retry',
  async ({ code, status, text }) => {
    const fixture = await openSession();
    fixture.setRejection({ code, status });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled(),
    );
    await fixture.user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent(text),
    );
    expect(screen.getByLabelText('Scene Installation')).toHaveValue(
      sessionInstallation.id,
    );
    expect(screen.getByLabelText('Session lifecycle')).toHaveTextContent(
      'Not started',
    );
    expect(fixture.current()).toBeNull();
    fixture.setRejection(null);
    await fixture.user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog')).queryByText(text, { exact: false }),
      ).not.toBeInTheDocument(),
    );
    await fixture.cleanup();
  },
);

test('a disabled source exposes its recovery instruction and keeps installation operable without claiming Running', async () => {
  const fixture = await openSession({ enabled: false });
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'The server has no development synthetic source enabled',
  );
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Install fixed scene' }),
  ).toBeEnabled();
  expect(screen.getByLabelText('Session lifecycle')).toHaveTextContent(
    'Not started',
  );
  await fixture.cleanup();
});
