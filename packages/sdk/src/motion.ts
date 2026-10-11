import {
  decodeMotionSnapshot,
  parseMotionControl,
  type MotionControl,
  type MotionSnapshot,
  type MotionWelcome,
} from '@labos-threejs/contracts/motion';
import type { Client } from './generated/client';
import {
  getLabMotionFixture,
  createLabMotionFixture,
  createLabMotionViewerTicket,
  createLabSessionViewerTicket,
} from './generated/sdk.gen';
import type { MotionFixture, MotionTicket } from '@labos-threejs/contracts';

export type SyntheticMotionFixture = MotionFixture;
export type MotionViewerTicket = MotionTicket;
type HttpOptions = {
  client: Client;
  labId: string;
  signal?: AbortSignal;
  headers?: HeadersInit;
};

export async function getMotionFixture(
  options: HttpOptions,
): Promise<SyntheticMotionFixture> {
  const result = await getLabMotionFixture({
    client: options.client,
    path: { lab_id: options.labId },
    signal: options.signal,
    headers: Object.fromEntries(new Headers(options.headers)),
    throwOnError: true,
  });
  return result.data;
}
export async function createMotionFixture(
  options: HttpOptions & { representationId: string },
): Promise<SyntheticMotionFixture> {
  const result = await createLabMotionFixture({
    client: options.client,
    path: { lab_id: options.labId },
    signal: options.signal,
    headers: Object.fromEntries(new Headers(options.headers)),
    body: { representation_id: options.representationId },
    throwOnError: true,
  });
  return result.data;
}
export async function requestMotionViewerTicket(
  options: HttpOptions & { sessionId: string; rateHz: 15 | 30 },
): Promise<MotionViewerTicket> {
  const result = await createLabMotionViewerTicket({
    client: options.client,
    path: { lab_id: options.labId, session_id: options.sessionId },
    signal: options.signal,
    headers: Object.fromEntries(new Headers(options.headers)),
    body: { preferred_rate_hz: options.rateHz },
    throwOnError: true,
  });
  return result.data;
}

export async function requestSessionViewerTicket(
  options: HttpOptions & { sessionId: string; rateHz: 15 | 30 },
): Promise<MotionViewerTicket> {
  const result = await createLabSessionViewerTicket({
    client: options.client,
    path: { lab_id: options.labId, session_id: options.sessionId },
    signal: options.signal,
    headers: Object.fromEntries(new Headers(options.headers)),
    body: { preferred_rate_hz: options.rateHz },
    throwOnError: true,
  });
  return result.data;
}

export type MotionTransport = {
  send: (text: string) => void;
  close: () => void;
  dispose: () => void;
};
export type MotionTransportAdapter = (
  url: string,
  callbacks: {
    open: () => void;
    message: (data: string | ArrayBuffer) => void;
    close: () => void;
    error: () => void;
  },
) => MotionTransport;

/** WS is the initial adapter; codecs and receive-clock logic have no socket dependency. */
export const webSocketMotionTransport: MotionTransportAdapter = (
  url,
  callbacks,
) => {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const message = (event: MessageEvent) =>
    callbacks.message(event.data as string | ArrayBuffer);
  socket.addEventListener('open', callbacks.open);
  socket.addEventListener('message', message);
  socket.addEventListener('close', callbacks.close);
  socket.addEventListener('error', callbacks.error);
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
    dispose: () => {
      socket.removeEventListener('open', callbacks.open);
      socket.removeEventListener('message', message);
      socket.removeEventListener('close', callbacks.close);
      socket.removeEventListener('error', callbacks.error);
    },
  };
};

export class MotionConnectionError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export async function subscribeMotion(
  options: HttpOptions & {
    sessionId: string;
    sceneHash: string;
    rateHz: 15 | 30;
    signal: AbortSignal;
    transport?: MotionTransportAdapter;
    onWelcome: (welcome: MotionWelcome) => void;
    onSnapshot: (snapshot: MotionSnapshot, receivedAt: number) => void;
    onStatus?: (status: Exclude<MotionControl, MotionWelcome>) => void;
    requestTicket?: typeof requestMotionViewerTicket;
  },
): Promise<void> {
  if (options.signal.aborted) return;
  const ticket = await (options.requestTicket ?? requestMotionViewerTicket)(
    options,
  );
  if (options.signal.aborted) return;
  const base =
    options.client.getConfig().baseUrl || globalThis.location?.origin;
  const url = new URL(ticket.websocket_path, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new MotionConnectionError('invalid_url');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  await new Promise<void>((resolve, reject) => {
    let welcome: MotionWelcome | null = null;
    let lastSequence = -1n;
    let settled = false;
    let transport: MotionTransport | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      transport?.dispose();
      transport?.close();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    const timeout = setTimeout(
      () => finish(new MotionConnectionError('admission_timeout')),
      5_000,
    );
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      transport = (options.transport ?? webSocketMotionTransport)(
        url.toString(),
        {
          open: () =>
            transport?.send(
              JSON.stringify({
                type: 'motion.hello',
                version: 1,
                codec: 'pose-f32-v1',
                role: 'viewer',
                session_id: options.sessionId,
                ticket: ticket.ticket,
                preferred_rate_hz: options.rateHz,
              }),
            ),
          message: (data) => {
            if (settled) return;
            try {
              if (typeof data === 'string') {
                const control = parseMotionControl(data);
                if (control.type === 'motion.welcome') {
                  if (
                    control.session_id !== options.sessionId ||
                    control.scene_hash !== options.sceneHash
                  )
                    throw new MotionConnectionError('wrong_session');
                  if (
                    welcome &&
                    (BigInt(control.epoch) < BigInt(welcome.epoch) ||
                      (control.epoch === welcome.epoch &&
                        control.mapping_revision <= welcome.mapping_revision))
                  )
                    throw new MotionConnectionError('metadata_regression');
                  welcome = control;
                  lastSequence = -1n;
                  clearTimeout(timeout);
                  options.onWelcome(control);
                } else {
                  if (control.type === 'motion.error')
                    throw new MotionConnectionError(control.code);
                  if (!welcome)
                    throw new MotionConnectionError('welcome_required');
                  options.onStatus?.(control);
                  if (
                    control.type === 'motion.status' &&
                    control.state === 'closed'
                  )
                    finish(new MotionConnectionError('session_closed'));
                }
              } else {
                if (!welcome)
                  throw new MotionConnectionError('welcome_required');
                const snapshot = decodeMotionSnapshot(data, {
                  epoch: BigInt(welcome.epoch),
                  mapping_revision: welcome.mapping_revision,
                  body_count: welcome.pose_keys.length,
                  joint_count: welcome.joint_keys.length,
                });
                if (snapshot.sequence <= lastSequence)
                  throw new MotionConnectionError('sequence_regression');
                lastSequence = snapshot.sequence;
                options.onSnapshot(snapshot, performance.now());
              }
            } catch (error) {
              finish(error);
            }
          },
          close: () => finish(new MotionConnectionError('connection_closed')),
          error: () => finish(new MotionConnectionError('transport_error')),
        },
      );
      if (settled) {
        transport.dispose();
        transport.close();
      }
      if (options.signal.aborted) abort();
    } catch (error) {
      finish(error);
    }
  });
}

/** The authoritative Session and development fixture share only the read-only transport. */
export function subscribeSessionMotion(
  options: Parameters<typeof subscribeMotion>[0],
) {
  return subscribeMotion({
    ...options,
    requestTicket: requestSessionViewerTicket,
  });
}
