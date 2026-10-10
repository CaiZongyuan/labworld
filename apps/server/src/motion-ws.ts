import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  parseMotionHello,
  type MotionErrorCode,
} from '../../../packages/contracts/src/motion/index.ts';
import {
  MotionGateway,
  type MotionTransport,
} from '../../../packages/server/src/lab/motion/gateway.ts';
import {
  MotionFixtures,
  loopback,
} from '../../../packages/server/src/lab/motion/fixture.ts';
function bytes(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
export class MotionWebSockets {
  private ws = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
    clientTracking: true,
  });
  private gateway = new MotionGateway();
  private server?: Server;
  private stopping = false;
  private admissions = new Set<Promise<void>>();
  private deadlines = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  constructor(privateFixtures: MotionFixtures, origin: string) {
    this.fixtures = privateFixtures;
    this.origin = origin;
  }
  private fixtures: MotionFixtures;
  private origin: string;
  private upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    const reject = () => {
      socket.end(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        () => socket.destroy(),
      );
    };
    const match = request.url?.match(
      /^\/api\/v1\/lab\/motion\/sessions\/([0-9a-f-]{36})\/(viewer|publisher)$/,
    );
    // Check the actual TCP peer. Proxy headers cannot enable this local fixture.
    if (
      !match ||
      this.stopping ||
      !this.fixtures.enabled ||
      !loopback(request.socket.remoteAddress) ||
      ['forwarded', 'x-forwarded-for', 'x-real-ip'].some(
        (name) => request.headers[name] !== undefined,
      ) ||
      this.ws.clients.size >= 128 ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== this.origin) ||
      (match[2] === 'viewer' && request.headers.origin !== this.origin)
    ) {
      reject();
      return;
    }
    this.ws.handleUpgrade(request, socket, head, (ws) =>
      this.connection(ws, match[1], match[2] as 'viewer' | 'publisher'),
    );
  };
  attach(server: Server) {
    if (this.server)
      throw new Error('Motion WebSocket owner is already attached');
    this.server = server;
    server.on('upgrade', this.upgrade);
  }
  private connection(
    ws: WebSocket,
    session: string,
    role: 'viewer' | 'publisher',
  ) {
    const transport: MotionTransport = {
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      get open() {
        return ws.readyState === WebSocket.OPEN;
      },
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(data, { binary: typeof data !== 'string' });
      },
      close: (code, reason) => {
        if (
          ws.readyState !== WebSocket.OPEN &&
          ws.readyState !== WebSocket.CONNECTING
        )
          return;
        ws.close(code, reason);
        if (!this.deadlines.has(ws))
          this.deadlines.set(
            ws,
            setTimeout(() => ws.terminate(), 250),
          );
      },
    };
    let joined: ReturnType<MotionGateway['join']>;
    let admitting = false;
    let admitted = false;
    let closed = false;
    const timeout = setTimeout(
      () =>
        this.gateway.reject(
          transport,
          'unauthorized',
          'Motion admission timed out',
        ),
      3000,
    );
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      clearTimeout(this.deadlines.get(ws));
      this.deadlines.delete(ws);
      joined?.leave();
      // ws owns its client-tracking close listener. Remove only our callbacks.
      ws.off('message', receive);
      ws.off('error', terminate);
      ws.off('close', cleanup);
    };
    const terminate = () => ws.terminate();
    const receive = (raw: RawData, binary: boolean) => {
      const data = bytes(raw);
      if (!admitted) {
        if (admitting || binary || data.byteLength > 4096) {
          this.gateway.reject(
            transport,
            'invalid_message',
            'Send one bounded motion HELLO',
          );
          return;
        }
        admitting = true;
        const admission = (async () => {
          try {
            const hello = parseMotionHello(
              new TextDecoder('utf-8', { fatal: true }).decode(data),
            );
            if (hello.role !== role || hello.session_id !== session)
              throw new Error('Wrong admission scope');
            const { metadata, rate } = await this.fixtures.consume(
              hello.ticket,
              session,
              role,
            );
            if (
              hello.role === 'publisher' &&
              hello.scene_hash !== metadata.scene_hash
            ) {
              this.gateway.reject(
                transport,
                'mapping_mismatch',
                'Scene hash mismatch',
              );
              return;
            }
            if (closed || this.stopping || !transport.open) return;
            joined = this.gateway.join(metadata, role, rate, transport);
            admitted = !!joined;
            clearTimeout(timeout);
          } catch {
            this.gateway.reject(
              transport,
              'unauthorized',
              'Motion admission failed',
            );
          }
        })();
        this.admissions.add(admission);
        void admission.finally(() => this.admissions.delete(admission));
        return;
      }
      if (!binary) {
        this.gateway.reject(
          transport,
          'invalid_message',
          'Only binary snapshots are accepted after admission',
        );
        return;
      }
      try {
        joined?.receive(data);
      } catch (error) {
        this.gateway.reject(
          transport,
          error && typeof error === 'object' && 'code' in error
            ? (error.code as MotionErrorCode)
            : 'invalid_message',
          'Motion message was rejected',
        );
      }
    };
    ws.on('error', terminate);
    ws.on('close', cleanup);
    ws.on('message', receive);
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.server?.off('upgrade', this.upgrade);
    this.fixtures.stop();
    this.gateway.stop();
    for (const ws of this.ws.clients) ws.terminate();
    await Promise.allSettled([...this.admissions]);
    for (const timeout of this.deadlines.values()) clearTimeout(timeout);
    this.deadlines.clear();
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
  }
}
