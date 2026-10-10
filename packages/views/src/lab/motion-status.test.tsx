import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, passthrough } from 'msw';
import { WebSocketServer, WebSocket } from 'ws';
import { expect, onTestFinished, test, vi } from 'vitest';
import { createApiClient, type LabWorld } from '@labos-threejs/sdk';
import { encodeMotionSnapshot } from '@labos-threejs/contracts/motion';
import { server } from '../../../../tests/frontend/server';
import {
  motionWelcome,
  motionSnapshot,
} from '../../../../tests/frontend/motion-fixture';
import { MotionControls } from './motion-controls';
import { useMotion } from './use-motion';
import { PreferencesProvider } from '../shell/preferences';
import { AppMessagesProvider } from '../shell/messages';
import { labApp } from './app';

test.each(['waiting', 'stale', 'paused', 'interrupted'] as const)(
  'public controls keep %s after a cached late join and status ticks, then resume only with live source data',
  async (sourceState) => {
    const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let unmount = () => {};
    let released: Promise<void> | undefined;
    const release = () =>
      (released ??= (async () => {
        unmount();
        vi.useRealTimers();
        await Promise.all(
          [...sockets.clients].map(
            (socket) =>
              new Promise<void>((resolve) => {
                if (socket.readyState === WebSocket.CLOSED) {
                  resolve();
                  return;
                }
                socket.once('close', resolve);
                socket.terminate();
              }),
          ),
        );
        await new Promise<void>((resolve, reject) =>
          sockets.close((error) => (error ? reject(error) : resolve())),
        );
        expect(sockets.clients.size).toBe(0);
        vi.unstubAllGlobals();
      })());
    onTestFinished(release);
    await new Promise<void>((resolve) => sockets.once('listening', resolve));
    const address = sockets.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing owned socket port');
    const websocketPath = `http://127.0.0.1:${address.port}/motion`;
    let peer!: WebSocket;
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    sockets.on('connection', (socket) => {
      peer = socket;
      socket.once('message', () => {
        socket.send(JSON.stringify(motionWelcome));
        socket.send(
          JSON.stringify({
            type: 'motion.status',
            state: sourceState,
            rate_hz: 30,
          }),
        );
        socket.send(encodeMotionSnapshot(motionSnapshot()));
        // A rate-status marker establishes that the preceding binary has reached the consumer.
        socket.send(
          JSON.stringify({
            type: 'motion.status',
            state: sourceState,
            rate_hz: 15,
          }),
        );
        admitted();
      });
    });
    server.use(
      // Pass the real Node WS upgrade through HTTP interception without replacing any frames.
      http.get(websocketPath, () => passthrough()),
      http.get('http://api.test/api/v1/lab/labs/shared/motion-fixture', () =>
        HttpResponse.json({ ...motionWelcome, lab_id: 'shared' }),
      ),
      http.post(
        'http://api.test/api/v1/lab/labs/shared/motion-fixture/:session/viewer-tickets',
        () =>
          HttpResponse.json({
            ticket: 'scoped_ticket_123456789',
            expires_in_seconds: 30,
            websocket_path: websocketPath,
          }),
      ),
    );
    window.localStorage.setItem('labos-threejs.locale', 'en');
    const client = createApiClient('http://api.test');
    const world = { assets: [] } as unknown as LabWorld;
    const onFixtureCreated = vi.fn();
    function ConnectedControls() {
      const motion = useMotion({
        apiClient: client,
        labId: 'shared',
        csrfToken: 'csrf-motion',
        onFixtureCreated,
      });
      return <MotionControls motion={motion} world={world} disabled={false} />;
    }
    const user = userEvent.setup();
    // Only the UI status interval is advanced; transport/HTTP/handshake deadlines remain real.
    try {
      // jsdom's Undici WebSocket dispatches Node EventTarget events across DOM realms.
      // The real Node ws client uses the same public browser socket API without that realm mismatch.
      vi.stubGlobal('WebSocket', WebSocket);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const view = render(
        <PreferencesProvider>
          <AppMessagesProvider app={labApp}>
            <ConnectedControls />
          </AppMessagesProvider>
        </PreferencesProvider>,
      );
      unmount = view.unmount;
      await user.click(
        screen.getByRole('button', { name: /Synthetic motion/ }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Join existing session' }),
      );
      await admission;
      const label =
        sourceState === 'waiting'
          ? 'Waiting for publisher'
          : sourceState === 'stale'
            ? 'Motion stale · pose frozen'
            : sourceState === 'paused'
              ? 'Motion paused · pose frozen'
              : 'Motion interrupted';
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          `${label} · 15 Hz`,
        ),
      );
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole('status')).toHaveTextContent(label);
      peer.send(
        encodeMotionSnapshot(
          motionSnapshot({
            sequence: 9007199254740994n,
            sim_time_ns: 9007199354740993n,
          }),
        ),
      );
      peer.send(
        JSON.stringify({
          type: 'motion.status',
          state: sourceState,
          rate_hz: 30,
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          `${label} · 30 Hz`,
        ),
      );
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole('status')).toHaveTextContent(label);
      peer.send(
        JSON.stringify({ type: 'motion.status', state: 'live', rate_hz: 30 }),
      );
      peer.send(
        encodeMotionSnapshot(
          motionSnapshot({
            sequence: 9007199254740995n,
            sim_time_ns: 9007199454740993n,
          }),
        ),
      );
      peer.send(
        JSON.stringify({ type: 'motion.status', state: 'live', rate_hz: 15 }),
      );
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          'Motion connected · 15 Hz',
        ),
      );
      await user.click(screen.getByRole('button', { name: 'Leave motion' }));
      expect(screen.getByRole('status')).toHaveTextContent('Disconnected');
    } finally {
      await release();
    }
  },
);
