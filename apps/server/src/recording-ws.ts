import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  parseRecordingHello,
  recordingJSON,
  recordingObject,
  recordingU64,
  RECORDING_HEADER_BYTES,
  RECORDING_WIRE_LIMITS,
} from '../../../packages/contracts/src/recording/index.ts';
import { motionTransportAllowed } from './transport.ts';
import type {
  RecordingSourceAuthority,
  RecordingSourceConnection,
  RecordingSourceScope,
} from '../../../packages/server/src/lab/recordings/source.ts';

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
type IncomingDiagnostic = {
  arrivalMonotonicMs: number;
  tokensBeforeRefill: number;
  refillElapsedMs: number;
  tokensAfterRefill: number;
  tokensAfterCharge: number;
  charged: boolean;
  binary: boolean;
  byteCount: number;
  header: 'valid-structure' | 'invalid' | 'not-binary';
  packetSequence: string | null;
  packetKind: number | null;
  inflightPresent: boolean;
  equalsInflight: boolean;
};
type CapacityBranch =
  | 'commands-buffer'
  | 'heartbeat-buffer'
  | 'receive-rate'
  | 'receive-size-buffer'
  | 'ack-size-buffer'
  | 'peer-fault';
type CapacityDiagnostic = {
  admittedMessages: number;
  recentMessages: IncomingDiagnostic[];
  firstCapacity?: {
    atMonotonicMs: number;
    branch: CapacityBranch;
    tokens: number;
    checkedBytes: number | null;
    bufferedBytes: number | null;
    byteLimit: number | null;
    recentMessages: readonly IncomingDiagnostic[];
  };
};
// Diagnostic header facts only: neither scope nor digest validation is claimed.
function diagnosticHeader(data: Uint8Array, binary: boolean) {
  const empty = {
    header: binary ? ('invalid' as const) : ('not-binary' as const),
    packetSequence: null,
    packetKind: null,
  };
  if (
    !binary ||
    data.byteLength < RECORDING_HEADER_BYTES ||
    data.byteLength > RECORDING_WIRE_LIMITS.packet_bytes
  )
    return empty;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = view.getUint8(5),
    payloadBytes = data.byteLength - RECORDING_HEADER_BYTES;
  if (
    view.getUint32(0, false) !== 0x4c575231 ||
    view.getUint8(4) !== 1 ||
    ![1, 2, 3, 4].includes(kind) ||
    view.getUint16(6, true) !== 0 ||
    view.getUint32(60, true) !== 0 ||
    view.getUint32(56, true) !== payloadBytes ||
    ((kind === 2 || kind === 4) &&
      payloadBytes > RECORDING_WIRE_LIMITS.event_bytes) ||
    (kind === 3 && payloadBytes > RECORDING_WIRE_LIMITS.end_bytes) ||
    view.getBigUint64(48, true) === 0n
  )
    return empty;
  return {
    header: 'valid-structure' as const,
    packetSequence: String(view.getBigUint64(48, true)),
    packetKind: kind,
  };
}
/** Participates in the runtime's single upgrade dispatcher; owns no HTTP listener. */
export class RecordingWebSockets {
  private ws = new WebSocketServer({
    noServer: true,
    maxPayload: RECORDING_WIRE_LIMITS.packet_bytes,
    perMessageDeflate: false,
    clientTracking: true,
  });
  private stopping = false;
  private admissions = new Set<Promise<void>>();
  private receives = new Set<Promise<void>>();
  private closeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private scopes = new Map<
    WebSocket,
    { sessionId: string; fence: () => void }
  >();
  private authority: RecordingSourceAuthority;
  private origin: string;
  private heartbeatGraceMs: number;
  private capacity: () => boolean;
  // Diagnostic branch only: bounded connections survive close through final receipt.
  private diagnosticConnections: CapacityDiagnostic[] = [];
  private diagnosticConnectionsOmitted = 0;
  constructor(
    authority: RecordingSourceAuthority,
    origin: string,
    heartbeatGraceMs = 5000,
    capacity: () => boolean = () => true,
  ) {
    this.authority = authority;
    this.origin = origin;
    this.heartbeatGraceMs = heartbeatGraceMs;
    this.capacity = capacity;
  }
  get connections() {
    return this.ws.clients.size;
  }
  tryUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const match = request.url?.match(
      /^\/api\/v1\/lab\/recordings\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/source$/,
    );
    if (!match) return false;
    if (
      this.stopping ||
      !motionTransportAllowed(request) ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== this.origin) ||
      this.ws.clients.size >= 128 ||
      !this.capacity()
    ) {
      socket.end(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        () => socket.destroy(),
      );
      return true;
    }
    this.ws.handleUpgrade(request, socket, head, (ws) =>
      this.connection(ws, match[1]),
    );
    return true;
  }
  private close(ws: WebSocket) {
    if (ws.readyState === WebSocket.CLOSED) return;
    ws.close(1008, 'Recording source rejected');
    if (!this.closeTimers.has(ws))
      this.closeTimers.set(
        ws,
        setTimeout(() => ws.terminate(), 250),
      );
  }
  private connection(ws: WebSocket, recordingId: string) {
    let scope: RecordingSourceScope | undefined;
    let binding: RecordingSourceConnection | undefined;
    let admitting = false,
      admitted = false,
      closed = false,
      faulted = false;
    let inflight: Uint8Array | undefined;
    let lastPong = Date.now();
    let tokens = 16,
      tokenAt = Date.now();
    let diagnostic: CapacityDiagnostic | undefined;
    if (process.env.RECORDING_FIRST_FAULT_DIAGNOSTIC === 'true') {
      if (this.diagnosticConnections.length < 16) {
        diagnostic = { admittedMessages: 0, recentMessages: [] };
        this.diagnosticConnections.push(diagnostic);
      } else this.diagnosticConnectionsOmitted++;
    }
    const capacityFact = (
      branch: CapacityBranch,
      checkedBytes: number | null = null,
      bufferedBytes: number | null = null,
      byteLimit: number | null = null,
    ) => {
      if (!diagnostic || diagnostic.firstCapacity) return;
      diagnostic.firstCapacity = Object.freeze({
        atMonotonicMs: performance.now(),
        branch,
        tokens,
        checkedBytes,
        bufferedBytes,
        byteLimit,
        recentMessages: Object.freeze([...diagnostic.recentMessages]),
      });
    };
    const fail = (reason: string) => {
      if (faulted) return;
      faulted = true;
      if (scope) this.authority.fault(scope, reason);
      this.close(ws);
    };
    let dispatching = false;
    const sent = new Map<string, { at: number; last: number }>();
    const commands = setInterval(() => {
      if (
        !admitted ||
        faulted ||
        closed ||
        dispatching ||
        !binding?.commands ||
        ws.readyState !== WebSocket.OPEN
      )
        return;
      dispatching = true;
      const dispatch = (async () => {
        try {
          const pending = await binding!.commands!();
          if (faulted || closed || ws.readyState !== WebSocket.OPEN) return;
          const ids = new Set(pending.map((c) => c.command_id));
          for (const id of sent.keys()) if (!ids.has(id)) sent.delete(id);
          for (const command of pending) {
            const now = Date.now(),
              old = sent.get(command.command_id);
            if (
              old &&
              now - old.at > binding!.ready.limits.lifecycle_ack_timeout_ms
            )
              throw new Error('ack_timeout');
            if (old && now - old.last < 500) continue;
            const buffered = ws.bufferedAmount;
            if (buffered > 65536) {
              capacityFact('commands-buffer', null, buffered, 65536);
              throw new Error('recorder_capacity');
            }
            ws.send(JSON.stringify(command));
            sent.set(command.command_id, { at: old?.at ?? now, last: now });
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : 'invalid_packet');
        } finally {
          dispatching = false;
        }
      })();
      this.receives.add(dispatch);
      void dispatch.finally(() => this.receives.delete(dispatch));
    }, 100);
    commands.unref();
    const timeout = setTimeout(() => fail('source_disconnected'), 3000);
    const heartbeat = setInterval(() => {
      if (!admitted || faulted || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong >= this.heartbeatGraceMs) {
        fail('source_disconnected');
        return;
      }
      const buffered = ws.bufferedAmount;
      if (buffered > 65536) {
        capacityFact('heartbeat-buffer', null, buffered, 65536);
        fail('recorder_capacity');
        return;
      }
      ws.ping();
    }, 1000);
    heartbeat.unref();
    const pong = () => {
      lastPong = Date.now();
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      clearInterval(commands);
      clearTimeout(this.closeTimers.get(ws));
      this.closeTimers.delete(ws);
      this.scopes.delete(ws);
      binding?.leave('source_disconnected');
      ws.off('pong', pong);
      ws.off('message', receive);
      ws.off('error', terminate);
      ws.off('close', cleanup);
    };
    const terminate = () => {
      fail('source_disconnected');
      ws.terminate();
    };
    const receive = (raw: RawData, binary: boolean) => {
      if (closed || faulted) return;
      const data = bytes(raw);
      if (!admitted) {
        if (
          admitting ||
          binary ||
          data.byteLength > RECORDING_WIRE_LIMITS.hello_bytes
        ) {
          fail('invalid_packet');
          return;
        }
        admitting = true;
        const admission = (async () => {
          try {
            const hello = parseRecordingHello(
              new TextDecoder('utf-8', { fatal: true }).decode(data),
            );
            if (hello.recording_id !== recordingId)
              throw new Error('Wrong Recording endpoint scope');
            scope = await this.authority.consume(hello.ticket, recordingId);
            if (
              closed ||
              faulted ||
              this.stopping ||
              ws.readyState !== WebSocket.OPEN
            ) {
              this.authority.fault(scope, 'source_disconnected');
              return;
            }
            this.scopes.set(ws, {
              sessionId: scope.bootstrap.session_id,
              fence: () => {
                faulted = true;
                this.close(ws);
              },
            });
            binding = await this.authority.bind(scope, hello);
            if (
              closed ||
              faulted ||
              this.stopping ||
              ws.readyState !== WebSocket.OPEN
            ) {
              binding.leave('source_disconnected');
              return;
            }
            const ready = JSON.stringify(binding.ready);
            if (Buffer.byteLength(ready) > RECORDING_WIRE_LIMITS.hello_bytes)
              throw new Error('Recording READY exceeds wire budget');
            ws.send(ready);
            admitted = true;
            lastPong = Date.now();
            clearTimeout(timeout);
          } catch {
            fail('invalid_packet');
          }
        })();
        this.admissions.add(admission);
        void admission.finally(() => this.admissions.delete(admission));
        return;
      }
      const now = Date.now();
      const beforeRefill = tokens,
        refillElapsedMs = now - tokenAt;
      tokens = Math.min(16, tokens + (refillElapsedMs * 64) / 1000);
      tokenAt = now;
      const afterRefill = tokens;
      const inflightEqual =
        diagnostic && binary && inflight
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).equals(
              Buffer.from(
                inflight.buffer,
                inflight.byteOffset,
                inflight.byteLength,
              ),
            )
          : undefined;
      const incomingFact = (charged: boolean) => {
        if (!diagnostic) return;
        diagnostic.admittedMessages++;
        diagnostic.recentMessages.push(
          Object.freeze({
            arrivalMonotonicMs: performance.now(),
            tokensBeforeRefill: beforeRefill,
            refillElapsedMs,
            tokensAfterRefill: afterRefill,
            tokensAfterCharge: tokens,
            charged,
            binary,
            byteCount: data.byteLength,
            ...diagnosticHeader(data, binary),
            inflightPresent: !!inflight,
            equalsInflight: inflightEqual ?? false,
          }),
        );
        if (diagnostic.recentMessages.length > 32)
          diagnostic.recentMessages.shift();
      };
      if (tokens < 1) {
        incomingFact(false);
        capacityFact('receive-rate', data.byteLength);
        fail('recorder_capacity');
        return;
      }
      tokens -= 1;
      incomingFact(true);
      if (!binary) {
        try {
          const fault = recordingObject(
            recordingJSON(
              new TextDecoder('utf-8', { fatal: true }).decode(data),
              4096,
            ),
            [
              'type',
              'recording_id',
              'session_id',
              'lease_id',
              'epoch',
              'code',
              'last_selected_source_sequence',
              'last_selected_source_event_sequence',
              'last_verified_packet_sequence',
              'last_verified_source_sequence',
              'last_verified_event_sequence',
            ],
          );
          if (
            fault.type !== 'recording.fault' ||
            ['recording_id', 'session_id', 'lease_id', 'epoch'].some(
              (key) =>
                fault[key] !==
                scope!.bootstrap[
                  key as 'recording_id' | 'session_id' | 'lease_id' | 'epoch'
                ],
            )
          )
            throw new Error('Wrong fault scope');
          for (const key of [
            'last_selected_source_sequence',
            'last_selected_source_event_sequence',
            'last_verified_packet_sequence',
            'last_verified_source_sequence',
            'last_verified_event_sequence',
          ])
            recordingU64(fault[key]);
          if (
            typeof fault.code !== 'string' ||
            ![
              'scope_mismatch',
              'invalid_packet',
              'mapping_mismatch',
              'sequence_gap',
              'altered_duplicate',
              'stale_duplicate',
              'invalid_ack',
              'source_capacity',
              'recorder_capacity',
              'ack_timeout',
              'write_failed',
              'sync_failed',
              'source_disconnected',
              'source_crashed',
            ].includes(fault.code)
          )
            throw new Error('Invalid fault reason');
          if (fault.code === 'recorder_capacity')
            capacityFact('peer-fault', data.byteLength);
          fail(fault.code);
        } catch {
          fail('invalid_packet');
        }
        return;
      }
      const receiveBuffered =
        data.byteLength > RECORDING_WIRE_LIMITS.packet_bytes
          ? null
          : ws.bufferedAmount;
      if (
        data.byteLength > RECORDING_WIRE_LIMITS.packet_bytes ||
        (receiveBuffered !== null && receiveBuffered > 65536)
      ) {
        capacityFact(
          'receive-size-buffer',
          data.byteLength,
          receiveBuffered,
          RECORDING_WIRE_LIMITS.packet_bytes,
        );
        fail('recorder_capacity');
        return;
      }
      if (inflight) {
        if (
          inflightEqual ??
          Buffer.from(data.buffer, data.byteOffset, data.byteLength).equals(
            Buffer.from(
              inflight.buffer,
              inflight.byteOffset,
              inflight.byteLength,
            ),
          )
        )
          return;
        fail('altered_duplicate');
        return;
      }
      inflight = data;
      const receiving = (async () => {
        try {
          const ack = await binding!.receive(data);
          if (closed || faulted || ws.readyState !== WebSocket.OPEN) return;
          const encoded = JSON.stringify(ack);
          const ackBytes = Buffer.byteLength(encoded);
          const ackBuffered =
            ackBytes > RECORDING_WIRE_LIMITS.ack_bytes
              ? null
              : ws.bufferedAmount;
          if (
            ackBytes > RECORDING_WIRE_LIMITS.ack_bytes ||
            (ackBuffered !== null && ackBuffered > 65536)
          ) {
            capacityFact(
              'ack-size-buffer',
              ackBytes,
              ackBuffered,
              RECORDING_WIRE_LIMITS.ack_bytes,
            );
            fail('recorder_capacity');
            return;
          }
          ws.send(encoded);
        } catch (error) {
          fail(
            error && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : 'invalid_packet',
          );
        } finally {
          inflight = undefined;
        }
      })();
      this.receives.add(receiving);
      void receiving.finally(() => this.receives.delete(receiving));
    };
    ws.on('pong', pong);
    ws.on('message', receive);
    ws.on('error', terminate);
    ws.on('close', cleanup);
  }
  /** Synchronous intake fence for failures owned by storage/business events. */
  fence(sessionId: string) {
    for (const entry of this.scopes.values())
      if (entry.sessionId === sessionId) entry.fence();
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const ws of this.ws.clients) ws.terminate();
    await Promise.allSettled([...this.admissions, ...this.receives]);
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.closeTimers.clear();
    this.scopes.clear();
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
  }
}
