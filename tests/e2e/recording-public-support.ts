import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreHttp } from '../support/core-http.ts';
import {
  digest,
  readRecordingRecords,
  type RecordingRecord,
} from './recording-wire-oracle.ts';

export type RecordingMetadata = {
  id: string;
  session_id: string;
  lab_id: string;
  snapshot_hash: string;
  manifest_sha256: string | null;
  status:
    'preparing' | 'open' | 'complete' | 'incomplete' | 'deleting' | 'deleted';
  reason: string | null;
  integrity: 'recording' | 'complete' | 'incomplete';
  prefix: {
    source_packet_sequence: string;
    source_prefix_sha256: string | null;
    last_source_sequence: string;
    last_source_event_sequence: string;
    last_sim_time_ns: string;
    source_ended: boolean;
  };
};
export type RecordingEvent = {
  ordinal: string;
  event_id: string;
  event_type: string;
  entity_id: string | null;
  recorded_at: string;
  sim_time_ns: string | null;
  event: Record<string, unknown>;
};
export type RecordingSegment = {
  id: string;
  index: number;
  file_id: string | null;
  sealed: boolean;
  size: number;
  sha256: string;
  first_ordinal: string;
  last_ordinal: string;
};
export const recordingPath = (lab: string, id?: string) =>
  `/api/v1/lab/labs/${lab}/recordings${id ? '/' + id : ''}`;

const maximumEventPages =
  (Math.floor((1024 * 1024 * 1024) / 36) + 1) * (1024 + 1) +
  Math.ceil((1024 * 1024 * 1024) / 2 / 100);
function eventProgress(cursor: string) {
  const envelope = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  );
  const position =
    envelope.v === 1
      ? JSON.parse(Buffer.from(envelope.p, 'base64url').toString('utf8'))
      : envelope;
  return [
    BigInt(position.scan ?? '0'),
    BigInt(position.ordinal),
    BigInt(position.index),
    BigInt(position.lookup ? 1 : 0),
    BigInt(position.lookup?.scan ?? '0'),
  ];
}
function later(a: bigint[], b: bigint[]) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
async function pages<T>(api: CoreHttp, path: string, scanEvents = false) {
  const result: T[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  let previous: bigint[] | undefined,
    steps = 0;
  do {
    const response: { data: T[]; next_cursor: string | null } = await api.json(
      'GET',
      path +
        '?limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert(response.data.length <= 100);
    result.push(...response.data);
    cursor = response.next_cursor;
    if (cursor) {
      if (scanEvents) {
        const progress = eventProgress(cursor);
        assert(
          !previous || later(progress, previous),
          'Event scan cursor must make progress',
        );
        previous = progress;
        // Finite physical capacity and at most one lookback per commit; no cursor cache.
        assert(++steps <= maximumEventPages);
      } else {
        assert(!seen.has(cursor));
        assert(seen.size < 64);
        seen.add(cursor);
      }
    }
  } while (cursor);
  return result;
}
export const recordingEvents = (api: CoreHttp, path: string) =>
  pages<RecordingEvent>(api, path + '/events', true);

export async function recordingForSession(
  api: CoreHttp,
  lab: string,
  session: string,
) {
  const matches = (
    await pages<RecordingMetadata>(api, recordingPath(lab))
  ).filter((recording) => recording.session_id === session);
  assert.equal(matches.length, 1, 'Session must have exactly one Recording');
  return matches[0];
}

export async function publicRecording(api: CoreHttp, lab: string, id: string) {
  const path = recordingPath(lab, id);
  const metadata = await api.json<RecordingMetadata>('GET', path);
  const manifest = await api.json<{
    snapshot_hash: string;
    snapshot: Record<string, unknown>;
    capture_entity_ids: string[];
    physics_entity_ids: string[];
    capture_baseline: {
      recorded_at: string;
      entities: Record<string, unknown>[];
      commands: Record<string, unknown>[];
    };
  }>('GET', path + '/manifest');
  const segments = await pages<RecordingSegment>(api, path + '/segments');
  assert(segments.length <= 1024);
  const records: RecordingRecord[] = [];
  for (const segment of segments) {
    assert(segment.size >= 36 && segment.size <= 1024 * 1024);
    const response = await api.response(
      'GET',
      path + '/segments/' + segment.id,
    );
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (segment.sealed) {
      assert.equal(bytes.length, segment.size);
      assert.equal(digest(bytes), segment.sha256);
    } else {
      // Each public request is its own confirmed-prefix snapshot. A growing
      // unsealed segment must preserve every byte previously listed.
      assert(bytes.length >= segment.size, 'Listed confirmed prefix shrank');
      assert.equal(digest(bytes.subarray(0, segment.size)), segment.sha256);
    }
    // Validate even the newer returned suffix, then include only the earlier
    // list snapshot in this readback's ordinal/byte oracle.
    readRecordingRecords(bytes);
    const listed = readRecordingRecords(bytes.subarray(0, segment.size));
    assert.equal(listed[0]?.ordinal, segment.first_ordinal);
    assert.equal(listed.at(-1)?.ordinal, segment.last_ordinal);
    records.push(...listed);
    assert(records.length <= 10000);
  }
  records.forEach((record, index) =>
    assert.equal(record.ordinal, String(index + 1)),
  );
  const events = await recordingEvents(api, path);
  assert.equal(
    new Set(events.map((event) => event.event_id)).size,
    events.length,
  );
  return { metadata, manifest, segments, records, events };
}

const root =
  process.env.RECORDING_E2E_OUTPUT ??
  process.env.MOTION_E2E_OUTPUT ??
  process.env.LAB_NODE_EVIDENCE ??
  'test-results';

export function recordingReceipt(name: string, value: unknown) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name + '.json'), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
}

export function recordingStage(stage: string, detail: object = {}) {
  mkdirSync(root, { recursive: true });
  appendFileSync(
    join(root, 'recording-e2e-stages.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), stage, ...detail }) + '\n',
    { mode: 0o600 },
  );
}

export async function recordingEventually<T>(
  read: () => T | Promise<T>,
  accepted: (value: T) => boolean,
  timeout = 5000,
  diagnostic?: 'A' | 'B',
) {
  const deadline = performance.now() + timeout;
  let polls = 0,
    last: unknown,
    outcome = 'read-or-predicate-error';
  try {
    do {
      const value = await read();
      if (diagnostic) {
        polls++;
        last = recordingCompletionMetadata(value);
      }
      if (accepted(value)) {
        outcome = 'accepted';
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    outcome = 'timeout';
    throw new Error('Recording public condition did not become ready');
  } finally {
    if (diagnostic)
      try {
        recordingReceipt(`recording-completion-${diagnostic}`, {
          label: diagnostic,
          outcome,
          originalTimeoutMs: timeout,
          elapsedMs: performance.now() - (deadline - timeout),
          polls,
          last: last ?? null,
        });
      } catch {
        // Evidence cannot replace the original read/predicate/timeout result.
      }
  }
}

/** Last metadata from the original read only; identities and complete bodies stay private. */
export function recordingCompletionMetadata(value: unknown) {
  const body = value as RecordingMetadata & {
    gaps?: unknown[];
    seal?: {
      source_ended?: boolean;
      segment_count?: number;
      integrity?: string;
    };
  };
  const category = (item: unknown, allowed: string[]) =>
    typeof item === 'string' && allowed.includes(item)
      ? item
      : item == null
        ? null
        : 'unknown';
  const count = (item: unknown) =>
    typeof item === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(item)
      ? item
      : null;
  return {
    status: category(body?.status, [
      'preparing',
      'open',
      'complete',
      'incomplete',
      'deleting',
      'deleted',
    ]),
    integrity: category(body?.integrity, [
      'recording',
      'complete',
      'incomplete',
    ]),
    reason: category(body?.reason, [
      'stop_requested',
      'reset_requested',
      'stopped',
      'source_ended',
      'source_disconnected',
      'source_failed',
      'server_shutdown',
      'server_restarted',
      'recording_prepare_failed',
      'recording_event_prepare_failed',
      'recording_abort_failed',
      'recording_drain_timeout',
      'recording_seal_failed',
      'live_boundary_digest_mismatch',
      'recording_event_bytes_missing',
      'integrity_unconfirmed',
      'offline_archive_recovery',
      'reset_source_drain_incomplete',
      'reset_prepare_failed',
    ]),
    sourceEnded:
      typeof body?.prefix?.source_ended === 'boolean'
        ? body.prefix.source_ended
        : null,
    sourcePackets: count(body?.prefix?.source_packet_sequence),
    sourceFrames: count(body?.prefix?.last_source_sequence),
    sourceEvents: count(body?.prefix?.last_source_event_sequence),
    lastSimTimeNs: count(body?.prefix?.last_sim_time_ns),
    gapCount: Array.isArray(body?.gaps) ? body.gaps.length : null,
    sealSourceEnded:
      typeof body?.seal?.source_ended === 'boolean'
        ? body.seal.source_ended
        : null,
    sealSegments:
      Number.isSafeInteger(body?.seal?.segment_count) &&
      body.seal!.segment_count! >= 0
        ? body.seal!.segment_count
        : null,
    sealIntegrity: category(body?.seal?.integrity, [
      'recording',
      'complete',
      'incomplete',
    ]),
  };
}

type SocketOwner = {
  name: string;
  session_id: string;
  recording_id: string;
  state: number;
};
const sockets = new Map<WebSocket, SocketOwner>();
let closing = false;

function socketLedger() {
  recordingReceipt('recording-owned-sockets', {
    owner: 'Independent issue72 public HTTP/WS verifier',
    creator_pid: process.pid,
    sockets: [...sockets.values()],
    docker: [],
    closing,
  });
}

export function ownRecordingSocket(
  socket: WebSocket,
  name: string,
  sessionId: string,
  recordingId: string,
) {
  assert(!closing, 'Recording socket owner has been cancelled');
  const owner: SocketOwner = {
    name,
    session_id: sessionId,
    recording_id: recordingId,
    state: socket.readyState,
  };
  sockets.set(socket, owner);
  socketLedger();
  socket.once('open', () => {
    owner.state = socket.readyState;
    socketLedger();
  });
  socket.once('close', () => {
    owner.state = socket.readyState;
    socketLedger();
  });
}

export async function closeRecordingSockets() {
  const settled = await Promise.allSettled(
    [...sockets.keys()].map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      // These are exclusively owned disposable clients. Termination is finite
      // even when a peer is paused or a fault intentionally withholds its ACK.
      socket.terminate();
      await recordingEventually(
        () => socket.readyState,
        (state) => state === WebSocket.CLOSED,
      );
    }),
  );
  socketLedger();
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, 'Owned Recording sockets did not close');
  sockets.clear();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    closing = true;
    void closeRecordingSockets().catch((error) => {
      console.error(error instanceof Error ? error.name : 'CleanupError');
      process.exitCode = 1;
    });
  });
