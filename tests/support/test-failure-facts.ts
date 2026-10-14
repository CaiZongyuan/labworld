// Failure-only evidence owned by the creating test fixture. No raw data leaves it.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreHttp } from './core-http.ts';

export const failureFactsEnabled = process.env.TEST_FAILURE_FACTS === '1';
const reasons = new Set([
  'session_closed',
  'session_ended',
  'server_shutdown',
  'server_restarted',
  'recording_interrupted',
  'unauthorized',
  'slow_viewer',
  'publisher_unauthorized',
  'publisher_conflict',
  'publisher_capacity',
  'publisher_preparing',
  'source_ack_timeout',
  'source_progress_timeout',
  'publisher_heartbeat_timeout',
  'publisher_disconnected',
  'source_unavailable',
  'source_exited',
  'source_control_unavailable',
  'source_preparation_failed',
  'source_failed',
  'recording_prepare_failed',
  'recording_event_prepare_failed',
  'recording_abort_failed',
  'recording_drain_timeout',
  'recording_seal_failed',
  'recording_closed',
  'recording_ack_timeout',
  'recording_read_timeout',
  'recording_gate_timeout',
  'recording_prepare_timeout',
  'recording_event_commit_timeout',
  'recording_event_prepare_timeout',
  'recording_event_abort_timeout',
  'recording_source_disconnected',
  'source_ended',
  'stop_requested',
  'reset_requested',
  'stopped',
  'integrity_unconfirmed',
  'reset_prepare_failed',
  'machine_revoked',
  'machine_expired',
  'machine_auth_timeout',
  'machine_deleted',
  'machine_scope_changed',
  'recording_commit_failed',
  'recording_event_commit_failed',
  'recording_source_timeout',
  'sequence_rejected',
]);
const messageTypes = new Set([
  'motion.welcome',
  'motion.session_control',
  'motion.error',
  'recording.ready',
  'recording.ack',
  'recording.error',
]);
const actions = new Set(['pause', 'resume', 'stop']);
const events: Record<string, string | number | boolean | null>[] = [];
const closes: Partial<Record<'live' | 'reliable', object>> = {};
let dropped = 0;
let generation = 0;
const capturedDirectories = new Set<string>();

export function beginFailureFixture() {
  if (!failureFactsEnabled) return;
  generation++;
  events.length = 0;
  delete closes.live;
  delete closes.reliable;
  dropped = 0;
}
export function currentFailureGeneration() {
  return generation;
}

function category(value: unknown, values: Set<string>) {
  return typeof value === 'string' && values.has(value)
    ? value
    : value == null
      ? null
      : 'unknown';
}
function reason(value: unknown) {
  if (typeof value === 'string' && value.startsWith('lab.'))
    value = value.slice(4);
  return category(value, reasons);
}
function channel(role: string) {
  return role === 'manual-live-publisher'
    ? 'live'
    : role === 'manual-reliable-source'
      ? 'reliable'
      : null;
}
function emit(value: Record<string, string | number | boolean | null>) {
  if (!failureFactsEnabled) return;
  if (events.length >= 64) {
    dropped++;
    return;
  }
  events.push({ at: performance.now(), ...value });
}
export function recordFailureStage(
  stage:
    | 'transition-request'
    | 'transition-returned'
    | 'control-wait'
    | 'control-returned',
  action: string,
) {
  if (failureFactsEnabled) emit({ stage, action: category(action, actions) });
}
export function recordFailureMessage(
  role: string,
  value: unknown,
  ownerGeneration: number,
) {
  if (
    !failureFactsEnabled ||
    ownerGeneration !== generation ||
    !value ||
    typeof value !== 'object'
  )
    return;
  const message = value as Record<string, unknown>,
    kind = category(message.type, messageTypes);
  if (!kind || kind === 'unknown') return;
  emit({
    stage: 'peer-message',
    channel: channel(role),
    kind,
    action: category(message.action, actions),
    code: reason(message.code),
    reason: reason(message.reason),
  });
}
export function recordFailureError(
  role: string,
  error: Error,
  ownerGeneration: number,
) {
  if (!failureFactsEnabled || ownerGeneration !== generation) return;
  const projected = closedError(error);
  emit({
    stage: 'peer-error',
    channel: channel(role),
    errorClass: projected.errorClass,
    code: projected.errorCode,
  });
}
export function recordFailureClose(
  role: string,
  code: number,
  bytes: Buffer,
  ownerGeneration: number,
) {
  if (!failureFactsEnabled || ownerGeneration !== generation) return;
  const owner = channel(role);
  if (!owner) return;
  const value = {
    stage: 'peer-close',
    channel: owner,
    code: Number.isInteger(code) ? code : null,
    reason: bytes.length <= 128 ? reason(bytes.toString('utf8')) : 'unknown',
    at: performance.now(),
  };
  closes[owner] = value;
  emit(value);
}

async function boundedMetadata(
  api: CoreHttp,
  path: string,
  kind: 'session' | 'recording' | 'task',
) {
  const started = performance.now(),
    controller = new AbortController();
  let httpStatus: number | null = null;
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    // Same normal authenticated GET semantics as CoreHttp, with a diagnostic-only bound.
    const response = await fetch(api.url + path, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        origin: api.url,
        ...api.headers,
        ...(api.cookie ? { cookie: api.cookie } : {}),
        ...(api.csrf ? { 'x-csrf-token': api.csrf } : {}),
      },
      signal: controller.signal,
    });
    httpStatus = response.status;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 65536) {
          controller.abort();
          return {
            kind,
            outcome: 'unknown',
            httpStatus: response.status,
            bodyExceededBound: true,
          };
        }
        chunks.push(next.value);
      }
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >;
    const allowed = new Set(
      kind === 'session'
        ? [
            'starting',
            'running',
            'pausing',
            'paused',
            'resuming',
            'stopping',
            'stopped',
            'interrupted',
          ]
        : kind === 'task'
          ? [
              'pending',
              'preparing',
              'running',
              'decelerating',
              'completed',
              'cancelled',
              'failed',
              'unknown',
              'interrupted',
            ]
          : [
              'preparing',
              'open',
              'complete',
              'incomplete',
              'deleting',
              'deleted',
            ],
    );
    const error =
      body.error && typeof body.error === 'object'
        ? (body.error as Record<string, unknown>)
        : null;
    return {
      kind,
      outcome: response.status === 503 ? 'read-unavailable' : 'ack',
      at: performance.now(),
      elapsedMs: performance.now() - started,
      httpStatus: response.status,
      status: category(body.status, allowed),
      reason: reason(body.reason),
      errorCode: reason(error?.code),
      revision:
        typeof body.revision === 'number' && Number.isSafeInteger(body.revision)
          ? body.revision
          : null,
      ended:
        typeof body.ended_at === 'string'
          ? true
          : body.ended_at === null
            ? false
            : null,
    };
  } catch {
    return {
      kind,
      outcome: 'unknown',
      at: performance.now(),
      elapsedMs: performance.now() - started,
      httpStatus,
      timedOut: controller.signal.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function captureRecordingFailure(
  api: CoreHttp,
  sessionPath: string,
  recordingPath: string,
  directory: string,
  stage:
    | 'initial-ready-failure'
    | 'control-failure'
    | 'recording-ready-failure'
    | 'recording-ack-failure',
  ownerGeneration = generation,
) {
  if (ownerGeneration !== generation || !claimFailure(directory)) return;
  const originalFailureAt = performance.now();
  try {
    const atFailure = peerSnapshot();
    const reads = await Promise.all([
      boundedMetadata(api, sessionPath, 'session'),
      boundedMetadata(api, recordingPath, 'recording'),
    ]);
    await safePublicFailure(directory, {
      scope:
        'Original ready/control/Recording receipt rejected; later HTTP reads are post-failure confirmation',
      stage,
      originalFailureAt,
      capturedAt: performance.now(),
      eventCap: 64,
      atFailure,
      reads,
      afterReads: peerSnapshot(),
    });
  } catch {
    // Observation never replaces the original cause/verdict.
  }
}

function claimFailure(directory: string) {
  if (!failureFactsEnabled || !directory || capturedDirectories.has(directory))
    return false;
  capturedDirectories.add(directory);
  return true;
}
function closedError(cause: unknown) {
  const error =
    cause && typeof cause === 'object'
      ? (cause as Record<string, unknown>)
      : {};
  const nested =
    error.cause && typeof error.cause === 'object'
      ? (error.cause as Record<string, unknown>)
      : {};
  return {
    errorClass: category(
      error.name,
      new Set([
        'Error',
        'AssertionError',
        'TypeError',
        'AbortError',
        'TimeoutError',
        'SyntaxError',
        'RangeError',
      ]),
    ),
    errorCode: category(
      error.code ?? nested.code,
      new Set([
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'EPIPE',
        'ERR_ASSERTION',
        'ABORT_ERR',
        'ERR_SOCKET_CLOSED',
      ]),
    ),
  };
}
const sessionStatuses = new Set([
  'starting',
  'running',
  'pausing',
  'paused',
  'resuming',
  'stopping',
  'stopped',
  'interrupted',
  'reset',
]);
export function createStateFacts(requested: string, pollDelayMs: 20 | 25) {
  return {
    generation,
    started: performance.now(),
    requestedStatus: category(requested, sessionStatuses),
    pollDelayMs,
    polls: 0,
    phase: 'not-read',
    last: null as object | null,
    firstTerminal: null as object | null,
  };
}
export function recordStateRead(
  facts: ReturnType<typeof createStateFacts>,
  value: Record<string, unknown>,
  elapsedMs: number,
) {
  if (!failureFactsEnabled || facts.generation !== generation) return;
  facts.phase = 'get-completed';
  const sample = {
    phase: 'get-completed',
    at: performance.now(),
    elapsedMs,
    httpStatus: 200,
    status: category(value.status, sessionStatuses),
    reason: reason(value.reason),
    revision:
      typeof value.revision === 'number' && Number.isSafeInteger(value.revision)
        ? value.revision
        : null,
    ended:
      typeof value.ended_at === 'string'
        ? true
        : value.ended_at === null
          ? false
          : null,
  };
  facts.last = sample;
  if (
    !facts.firstTerminal &&
    ['stopped', 'interrupted', 'reset'].includes(String(sample.status))
  )
    facts.firstTerminal = sample;
}
export function recordStateReadError(
  facts: ReturnType<typeof createStateFacts>,
  cause: unknown,
  elapsedMs: number,
) {
  if (!failureFactsEnabled || facts.generation !== generation) return;
  const error =
    cause && typeof cause === 'object'
      ? (cause as Record<string, unknown>)
      : {};
  facts.phase = 'get-rejected';
  facts.last = {
    phase: 'get-rejected',
    at: performance.now(),
    elapsedMs,
    httpStatus:
      error.code === 'ERR_ASSERTION' &&
      typeof error.actual === 'number' &&
      error.actual >= 100 &&
      error.actual <= 599
        ? error.actual
        : null,
    ...closedError(cause),
  };
}
export async function captureStateFailure(
  facts: ReturnType<typeof createStateFacts>,
  directory: string,
  cause: unknown,
) {
  if (facts.generation !== generation || !claimFailure(directory)) return;
  await safePublicFailure(directory, {
    stage: 'session-state-failure',
    originalWaitMs: 10000,
    requestAbortMs: 10000,
    pollDelayMs: facts.pollDelayMs,
    requestedStatus: facts.requestedStatus,
    originalFailureAt: performance.now(),
    elapsedMs: performance.now() - facts.started,
    polls: facts.polls,
    phase: facts.phase,
    firstTerminal: facts.firstTerminal,
    last: facts.last,
    ...closedError(cause),
    peerFacts: peerSnapshot(),
  });
}
export function createStartupFacts() {
  return {
    generation,
    started: performance.now(),
    phase: 'owned-spawn-wait' as 'owned-spawn-wait' | 'health-live-wait',
    spawnReturned: false,
    polls: 0,
    healthRequests: 0,
    firstHealth: null as object | null,
    lastHealth: null as object | null,
  };
}
export function recordHealthResult(
  facts: ReturnType<typeof createStartupFacts>,
  elapsedMs: number,
  httpStatus: number | null,
  cause?: unknown,
  getStarted = true,
) {
  if (!failureFactsEnabled || facts.generation !== generation) return;
  const sample = {
    phase: !getStarted
      ? 'health-before-get-rejected'
      : httpStatus === null
        ? 'health-get-rejected'
        : 'health-get-completed',
    actualGetStarted: getStarted,
    at: performance.now(),
    elapsedMs,
    httpStatus,
    ...(cause === undefined ? {} : closedError(cause)),
  };
  facts.firstHealth ??= sample;
  facts.lastHealth = sample;
}
export async function captureStartupFailure(
  facts: ReturnType<typeof createStartupFacts>,
  directory: string,
  cause: unknown,
  childSpawned: boolean | null,
  identityRecorded: boolean | null,
  childExitCode: number | null,
  childSignal: string | null,
) {
  if (facts.generation !== generation || !claimFailure(directory)) return;
  await safePublicFailure(directory, {
    stage: 'server-start-failure',
    phase: facts.phase,
    originalWaitMs: 30000,
    requestAbortMs: 1000,
    pollDelayMs: 25,
    originalFailureAt: performance.now(),
    elapsedMs: performance.now() - facts.started,
    spawnReturned: facts.spawnReturned,
    childSpawned,
    identityRecorded,
    childExitCode,
    childSignaled: childSpawned === null ? null : childSignal !== null,
    polls: facts.polls,
    firstHealth: facts.firstHealth,
    healthRequests: facts.healthRequests,
    lastHealth: facts.lastHealth,
    ...closedError(cause),
  });
}
async function safePublicFailure(directory: string, value: object) {
  try {
    await writeFile(
      join(directory, 'test-failure-facts.json'),
      JSON.stringify(value, null, 2) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Evidence cannot replace the exact original failure.
  }
}

export async function captureTaskReceiptFailure(
  api: CoreHttp,
  taskPath: string,
  sessionPath: string,
  directory: string,
  ownerGeneration: number,
  snapshot: {
    originalRejectedAt: number;
    matchingReceiptCount: number;
    messageCount: number;
    armedReceiptCount: number;
    childConnected: boolean | null;
    childExited: boolean | null;
    childExitCode: number | null;
  },
  cause: unknown,
) {
  if (ownerGeneration !== generation || !claimFailure(directory)) return;
  const atFailure = {
    originalRejectedAt: snapshot.originalRejectedAt,
    matchingReceiptCount: snapshot.matchingReceiptCount,
    receiptPresentAtRejection: snapshot.matchingReceiptCount > 0,
    messageCount: snapshot.messageCount,
    armedReceiptCount: snapshot.armedReceiptCount,
    childConnected: snapshot.childConnected,
    childExited: snapshot.childExited,
    childExitCode: snapshot.childExitCode,
  };
  try {
    const postFailureReads = await Promise.all([
      boundedMetadata(api, taskPath, 'task'),
      boundedMetadata(api, sessionPath, 'session'),
    ]);
    await safePublicFailure(directory, {
      stage: 'task-receipt-failure',
      scope:
        'Original IPC receipt wait rejected; these later HTTP reads are only post-failure public confirmation, never a during-wait result or Result/recovery proof',
      originalWaitMs: 20000,
      pollDelayMs: 20,
      postFailureReadAbortMs: 250,
      postFailureBodyCap: 65536,
      atFailure,
      postFailureReads,
      ...closedError(cause),
    });
  } catch {
    // Observation cannot replace the original receipt-wait cause.
  }
}

function peerSnapshot() {
  return {
    events: events.map((value) => ({ ...value })),
    closes: { ...closes },
    dropped,
    eventCap: 64,
  };
}
