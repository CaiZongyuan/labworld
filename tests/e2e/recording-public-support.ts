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

async function pages<T>(api: CoreHttp, path: string) {
  const result: T[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
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
      assert(!seen.has(cursor));
      assert(seen.size < 64);
      seen.add(cursor);
    }
  } while (cursor);
  return result;
}

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
  const events = await pages<RecordingEvent>(api, path + '/events');
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
) {
  const deadline = performance.now() + timeout;
  do {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  throw new Error('Recording public condition did not become ready');
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
