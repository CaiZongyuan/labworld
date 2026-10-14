// Temporary diagnostic fixture only. No identities, URLs, payloads or credentials leave it.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreHttp } from '../support/core-http.ts';

export const pauseFactsEnabled = process.env.WINDOWS_PAUSE_DIAGNOSTIC === '1';
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

export function pauseFixtureStart() {
  if (!pauseFactsEnabled) return;
  generation++;
  events.length = 0;
  delete closes.live;
  delete closes.reliable;
  dropped = 0;
}
export function pausePeerGeneration() {
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
  if (!pauseFactsEnabled) return;
  if (events.length >= 64) {
    dropped++;
    return;
  }
  events.push({ at: performance.now(), ...value });
}
export function pauseStage(
  stage:
    | 'transition-request'
    | 'transition-returned'
    | 'control-wait'
    | 'control-returned',
  action: string,
) {
  if (pauseFactsEnabled) emit({ stage, action: category(action, actions) });
}
export function pausePeerMessage(
  role: string,
  value: unknown,
  ownerGeneration: number,
) {
  if (
    !pauseFactsEnabled ||
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
export function pausePeerError(
  role: string,
  error: Error,
  ownerGeneration: number,
) {
  if (!pauseFactsEnabled || ownerGeneration !== generation) return;
  const code = (error as Error & { code?: unknown }).code;
  emit({
    stage: 'peer-error',
    channel: channel(role),
    errorClass: category(
      error.name,
      new Set([
        'Error',
        'AssertionError',
        'TypeError',
        'SyntaxError',
        'RangeError',
      ]),
    ),
    code: category(
      code,
      new Set([
        'ECONNRESET',
        'ECONNREFUSED',
        'EPIPE',
        'ETIMEDOUT',
        'ERR_SOCKET_CLOSED',
      ]),
    ),
  });
}
export function pausePeerClose(
  role: string,
  code: number,
  bytes: Buffer,
  ownerGeneration: number,
) {
  if (!pauseFactsEnabled || ownerGeneration !== generation) return;
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
  kind: 'session' | 'recording',
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

export async function capturePauseFailure(
  api: CoreHttp,
  sessionPath: string,
  recordingPath: string,
  directory: string,
) {
  if (!pauseFactsEnabled) return;
  const originalFailureAt = performance.now();
  try {
    const atFailure = {
      events: events.map((value) => ({ ...value })),
      closes: { ...closes },
      dropped,
    };
    const reads = await Promise.all([
      boundedMetadata(api, sessionPath, 'session'),
      boundedMetadata(api, recordingPath, 'recording'),
    ]);
    await writeFile(
      join(directory, 'windows-pause-failure.json'),
      JSON.stringify(
        {
          scope:
            'Only after the original control failure; same Node monotonic clock; no assertion time inferred',
          originalFailureAt,
          capturedAt: performance.now(),
          eventCap: 64,
          atFailure,
          reads,
          afterReads: {
            events: events.map((value) => ({ ...value })),
            closes: { ...closes },
            dropped,
          },
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Observation never replaces the original cause/verdict.
  }
}
