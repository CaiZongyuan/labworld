import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { promises, writeFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../apps/server/src/runtime.ts';
import { DeviceRuntime } from '../../packages/server/src/lab/devices/runtime.ts';
import { WebSocket, WebSocketServer } from 'ws';
import {
  readRecordingRecords,
  type RecordingRecord,
} from './recording-wire-oracle.ts';

// This entry is launched only by the isolated ServerProcess test supervisor.
// Faults are armed over its private IPC channel; production has no such route.
assert(process.send, 'Launch this fixture through the owned IPC supervisor');
type Arm = {
  point:
    'beforeWrite' | 'beforeSync' | 'beforePublish' | 'prepared' | 'committed';
  mode: 'fail' | 'block';
  kind?: string;
  event_type?: string;
  status?: string;
};
let arm: Arm | undefined;
let release: (() => void) | undefined;
let executionHeld = false;
let releaseExecution: (() => void) | undefined;

// Private trusted ordinary-device ingress, captured from the unchanged real
// runtime composition. No HTTP route, Row mutation or physics Task authority.
let ordinaryReport: DeviceRuntime['report'] | undefined;
const initializeDeviceRuntime = DeviceRuntime.prototype.initialize;
DeviceRuntime.prototype.initialize = async function () {
  await initializeDeviceRuntime.call(this);
  ordinaryReport = this.report.bind(this);
};

const viewers = new Map<
  WebSocket,
  {
    remote_port: number;
    session_id: string;
    max_buffer_bytes: number;
    samples: number;
    open: boolean;
    close_reason: string | null;
  }
>();
let pressureTimer: ReturnType<typeof setInterval> | undefined;
let pressureObserverMillis = 0;
const pressureUpgrade = WebSocketServer.prototype.handleUpgrade;
WebSocketServer.prototype.handleUpgrade = function (
  request,
  socket,
  head,
  callback,
) {
  return pressureUpgrade.call(this, request, socket, head, (ws, incoming) => {
    const match = request.url?.match(
      /^\/api\/v1\/lab\/motion\/sessions\/([0-9a-f-]{36})\/viewer$/,
    );
    if (match) {
      const row = {
        remote_port: request.socket.remotePort!,
        session_id: match[1],
        max_buffer_bytes: 0,
        samples: 0,
        open: true,
        close_reason: null as string | null,
      };
      assert(viewers.size < 128);
      viewers.set(ws, row);
      const close = ws.close.bind(ws);
      ws.close = (code?: number, reason?: string | Buffer) => {
        if (pressureTimer)
          row.close_reason =
            typeof reason === 'string' ? reason : (reason?.toString() ?? null);
        return close(code, reason);
      };
      ws.once('close', () => {
        row.open = false;
      });
    }
    callback(ws, incoming);
  });
};
function stopPressureObserver() {
  clearInterval(pressureTimer);
  pressureTimer = undefined;
}
function pressureSnapshot() {
  return {
    event: 'pressure-observer',
    owner_pid: process.pid,
    observer_millis: pressureObserverMillis,
    interval_ms: 50,
    boundary:
      'read-only actual ws.bufferedAmount/close observer; no target-side pause or replacement',
    viewers: [...viewers.values()],
  };
}

type NativeMethod = 'write' | 'sync';
type NativeIo = {
  id: number;
  owner_pid: number;
  path: string;
  fd: number;
  method: NativeMethod;
  native_state: 'pending' | 'completed' | 'rejected';
  product_state: 'held' | 'released' | 'settled';
  close_requested_while_held: boolean;
  closed: boolean;
};
let ioArm: { method: NativeMethod; recording_id: string } | undefined;
const heldIo = new Map<NativeIo, () => void>();
const ioEvidence: NativeIo[] = [];
const ioRoot = resolve(process.env.LAB_WORD_DATA_DIR!, 'recordings');
const originalOpen = promises.open;
const ioOutput = process.env.RECORDING_E2E_OUTPUT ?? 'test-results';

function saveIo() {
  mkdirSync(ioOutput, { recursive: true });
  writeFileSync(
    join(ioOutput, `recording-held-io-${process.pid}.json`),
    JSON.stringify(
      {
        owner_pid: process.pid,
        experiment:
          'Actual native method started; product-visible completion held. Kernel may already have completed.',
        operations: ioEvidence,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

function releaseIo() {
  for (const [entry, releaseHeld] of heldIo) {
    entry.product_state = 'released';
    releaseHeld();
  }
  if (heldIo.size) saveIo();
}

const ownedOpen: typeof originalOpen = async (file, flags, mode) => {
  const handle = await originalOpen(file, flags, mode);
  const filename = file instanceof URL ? fileURLToPath(file) : String(file);
  const path = resolve(filename),
    owned = relative(ioRoot, path);
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[\\/][0-9]{6}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.lwf$/.test(
      owned,
    )
  )
    return handle;
  // Only this fixture's canonical Recording journal handles are wrapped.
  // PGlite, Core blobs, directory sync and other projects' files are untouched.
  const recordingId = owned.split(/[\\/]/)[0];
  const nativeSync = handle.sync.bind(handle),
    nativeWrite = handle.write.bind(handle),
    nativeClose = handle.close.bind(handle);
  let planned: RecordingRecord | undefined;
  const entries: NativeIo[] = [];
  async function visibleCompletion<T>(
    method: NativeMethod,
    startNative: () => Promise<T>,
  ) {
    if (!ioArm || ioArm.method !== method || ioArm.recording_id !== recordingId)
      return startNative();
    ioArm = undefined;
    const entry: NativeIo = {
      id: ioEvidence.length + 1,
      owner_pid: process.pid,
      path,
      fd: handle.fd,
      method,
      native_state: 'pending',
      product_state: 'held',
      close_requested_while_held: false,
      closed: false,
    };
    const native = startNative(); // The ORIGINAL operation starts after its pre-I/O hook has returned.
    const result = native.then(
      (value) => {
        entry.native_state = 'completed';
        saveIo();
        process.send!({
          event: 'actual-io-native-completed',
          method,
          fd: entry.fd,
          path,
        });
        return value;
      },
      (error: unknown) => {
        entry.native_state = 'rejected';
        saveIo();
        process.send!({
          event: 'actual-io-native-rejected',
          method,
          fd: entry.fd,
          path,
        });
        throw error;
      },
    );
    void result.catch(() => {}); // Keep the original rejection owned until release.
    entries.push(entry);
    ioEvidence.push(entry);
    const held = new Promise<void>((releaseHeld) =>
      heldIo.set(entry, releaseHeld),
    );
    saveIo();
    process.send!({
      event: 'actual-io-held',
      ...entry,
      recording_id: recordingId,
      actual_native_started: true,
      planned,
    });
    try {
      await held;
      return await result;
    } finally {
      heldIo.delete(entry);
      entry.product_state = 'settled';
      saveIo();
      process.send!({ event: 'actual-io-settled', method, fd: entry.fd, path });
    }
  }
  handle.write = ((...args: Parameters<typeof handle.write>) => {
    if (ioArm?.recording_id === recordingId && Buffer.isBuffer(args[0])) {
      // Capture only the armed append's externally inspectable intent. No
      // per-sample observer runs during ordinary browser or pressure journeys.
      const bytes = args[0] as Buffer;
      try {
        planned = readRecordingRecords(bytes).find(
          (record) => record.kind === 'business.prepare',
        );
      } catch {
        planned = undefined;
      }
    }
    return visibleCompletion('write', () =>
      Reflect.apply(nativeWrite, handle, args),
    );
  }) as typeof handle.write;
  handle.sync = () => visibleCompletion('sync', nativeSync);
  handle.close = async () => {
    for (const entry of entries)
      if (entry.product_state === 'held')
        entry.close_requested_while_held = true;
    if (entries.length) saveIo();
    try {
      await nativeClose();
    } finally {
      for (const entry of entries) entry.closed = true;
      if (entries.length) saveIo();
    }
  };
  return handle;
};
promises.open = ownedOpen;
syncBuiltinESMExports();

async function preparedBatch(recording: string, batch: string) {
  const directory = join(
    process.env.LAB_WORD_DATA_DIR!,
    'recordings',
    recording,
  );
  const files = (await readdir(directory))
    .filter((name) => name.endsWith('.lwf'))
    .sort();
  assert(files.length <= 1024);
  for (const name of files) {
    const bytes = await readFile(join(directory, name));
    const records = readRecordingRecords(bytes);
    const found = records.find(
      (record) =>
        record.kind === 'business.prepare' && record.data.batch_id === batch,
    );
    if (found) return found;
  }
  throw new Error('Prepared batch is not in its synced owned journal');
}

async function fault(point: Arm['point'], recording: string, detail: string) {
  const current = arm;
  if (
    !current ||
    current.point !== point ||
    (current.kind && current.kind !== detail)
  )
    return;
  let prepared: RecordingRecord | undefined;
  if (point === 'prepared' || point === 'committed') {
    prepared = await preparedBatch(recording, detail);
    if (current.event_type) {
      const events = prepared.data.events as {
        event_type: string;
        event: Record<string, unknown>;
      }[];
      if (
        !events.some(
          (event) =>
            event.event_type === current.event_type &&
            (!current.status ||
              event.event.status === current.status ||
              ['command', 'task', 'program'].some(
                (key) =>
                  (event.event[key] as Record<string, unknown> | undefined)
                    ?.status === current.status,
              )),
        )
      )
        return;
    }
  }
  arm = undefined;
  process.send!({
    event: 'fault-reached',
    point,
    recording_id: recording,
    detail,
    prepared,
  });
  if (current.mode === 'fail') throw new Error('owned_recording_write_failure');
  await new Promise<void>((resolve) => {
    release = resolve;
  });
}

process.on(
  'message',
  (message: {
    operation: string;
    fault?: Arm;
    held?: boolean;
    io?: { method: NativeMethod; recording_id: string };
    report?: {
      binding: string;
      run: string;
      sequence: number;
      values: Record<string, unknown>;
      observed_at: string;
      quality: string;
    };
  }) => {
    if (message.operation === 'arm') {
      assert(!arm && !release);
      arm = message.fault;
      process.send!({ event: 'armed' });
    } else if (message.operation === 'release') {
      release?.();
      release = undefined;
    } else if (message.operation === 'execution') {
      executionHeld = !!message.held;
      if (!executionHeld) {
        releaseExecution?.();
        releaseExecution = undefined;
      }
      process.send!({ event: 'execution-configured', held: executionHeld });
    } else if (message.operation === 'arm-io') {
      assert(!ioArm && heldIo.size === 0);
      assert(message.io && ['write', 'sync'].includes(message.io.method));
      ioArm = message.io;
      process.send!({ event: 'actual-io-armed', ...ioArm });
    } else if (message.operation === 'release-io') {
      releaseIo();
      process.send!({ event: 'actual-io-release-requested' });
    } else if (message.operation === 'ordinary-report') {
      assert(ordinaryReport && message.report);
      const { binding, run: runId, ...report } = message.report;
      void ordinaryReport(binding, runId, report).then(
        (result) => process.send!({ event: 'ordinary-report-result', result }),
        (error: unknown) =>
          process.send!({
            event: 'ordinary-report-error',
            error_class: error instanceof Error ? error.name : 'ReportError',
          }),
      );
    } else if (message.operation === 'pressure-observe') {
      assert(!pressureTimer);
      pressureTimer = setInterval(() => {
        const started = performance.now();
        for (const [ws, row] of viewers) {
          if (!row.open) continue;
          row.samples++;
          row.max_buffer_bytes = Math.max(
            row.max_buffer_bytes,
            ws.bufferedAmount,
          );
        }
        pressureObserverMillis += performance.now() - started;
      }, 50);
      process.send!({ event: 'pressure-observer-ready' });
    } else if (message.operation === 'pressure-snapshot') {
      process.send!(pressureSnapshot());
    } else if (message.operation === 'pressure-stop') {
      stopPressureObserver();
      process.send!(pressureSnapshot());
    }
  },
);

await run(undefined, {
  recordingFaults: {
    beforeWrite: (recording: string, kind: string) =>
      fault('beforeWrite', recording, kind),
    beforeSync: (recording: string, kind: string) =>
      fault('beforeSync', recording, kind),
    beforePublish: (recording: string, segment: string) =>
      fault('beforePublish', recording, segment),
    prepared: (recording: string, batch: string) =>
      fault('prepared', recording, batch),
    committed: (recording: string, batch: string) =>
      fault('committed', recording, batch),
  },
  deviceExecutionGate: async () => {
    if (executionHeld)
      await new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
  },
});

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    arm = undefined;
    release?.();
    releaseExecution?.();
    ioArm = undefined;
    releaseIo();
    stopPressureObserver();
    promises.open = originalOpen;
    syncBuiltinESMExports();
  });
