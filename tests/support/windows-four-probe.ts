import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreHttp } from './core-http.ts';

export const windowsProbeEnabled = () =>
  process.env.LAB_WORLD_WINDOWS_PROBE === '1';
export type WindowsProbePhase =
  | 'task-initial-admission'
  | 'native-sync-pause'
  | 'formal-machine-pause'
  | 'pins-restart';
const filenames: Record<WindowsProbePhase, string> = {
  'task-initial-admission': 'windows-task-admission.json',
  'native-sync-pause': 'windows-native-sync.json',
  'formal-machine-pause': 'windows-formal-pause.json',
  'pins-restart': 'windows-pins-restart.json',
};
const httpCodes = [
  'lab.recording_gate_timeout',
  'lab.recording_event_prepare_timeout',
  'lab.recording_event_commit_timeout',
  'lab.recording_prepare_timeout',
  'lab.recording_read_timeout',
  'lab.recording_unavailable',
  'lab.synthetic_session_disabled',
  'lab.session_unavailable',
  'lab.publisher_capacity',
  'database.unavailable',
  'auth.session_unavailable',
];
const receiveCodes = [
  'lab.recording_ack_timeout',
  'lab.recording_lifecycle_event_rejected',
  'lab.recording_closed',
  'lab.recording_sequence_gap',
  'lab.recording_altered_duplicate',
  'lab.recording_source_rate',
  'lab.recording_time_rollback',
  'lab.recording_initial_state_rejected',
];
export function receiveCode(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return typeof code === 'string' && receiveCodes.includes(code)
    ? code
    : 'UNKNOWN';
}
export function safeSession(before: {
  status: string;
  revision: unknown;
  lease_id: unknown;
  epoch: unknown;
  ended_at: unknown;
}) {
  const decimal = (value: unknown) =>
    (typeof value === 'string' || typeof value === 'number') &&
    /^\d{1,20}$/.test(String(value))
      ? String(value)
      : null;
  return {
    status: [
      'starting',
      'running',
      'pausing',
      'paused',
      'resuming',
      'stopping',
      'stopped',
      'interrupted',
    ].includes(before.status)
      ? before.status
      : 'UNKNOWN',
    revision: decimal(before.revision),
    leaseNull: before.lease_id === null,
    epochString: decimal(before.epoch),
    ended: before.ended_at !== null,
  };
}

// The original assertion has already fired. Only its unread failed response is read.
export async function failedHttpCode(
  response: Response | undefined,
  expected: number,
  budget: number,
) {
  const started = performance.now();
  const unknown = (status: string) => ({
    status,
    code: 'UNKNOWN',
    elapsedMs: performance.now() - started,
  });
  if (
    !response ||
    response.status === expected ||
    response.bodyUsed ||
    !response.body ||
    budget <= 0
  )
    return unknown('not-observed');
  const reader = response.body.getReader();
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (!finished) {
          const part = await reader.read();
          if (finished) return unknown('timeout');
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 4096) return unknown('size-limit');
          chunks.push(part.value);
        }
        const code: unknown = JSON.parse(
          new TextDecoder().decode(Buffer.concat(chunks)),
        )?.error?.code;
        return typeof code === 'string' && httpCodes.includes(code)
          ? { status: 'observed', code, elapsedMs: performance.now() - started }
          : unknown('unclassified-code');
      })().catch(() => unknown('read-or-parse-error')),
      new Promise<ReturnType<typeof unknown>>((resolve) => {
        timer = setTimeout(
          () => resolve(unknown('timeout')),
          Math.min(250, budget),
        );
      }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* Pending read owns its lock until cancellation. */
    }
  }
}

export function writeWindowsProbe(
  evidence: string,
  phase: WindowsProbePhase,
  data: object,
) {
  try {
    const bytes =
      JSON.stringify(
        { phase, ownedLedgerBasename: 'owned-resources.json', ...data },
        null,
        2,
      ) + '\n';
    if (Buffer.byteLength(bytes) <= 8192)
      writeFileSync(join(evidence, filenames[phase]), bytes, { mode: 0o600 });
  } catch {
    /* An observation never replaces the original verdict. */
  }
}

export async function observedWindowsHttp<T>(
  client: CoreHttp,
  call: () => Promise<T>,
  expected: number,
  before: Parameters<typeof safeSession>[0],
  evidence: string,
  phase: 'task-initial-admission' | 'formal-machine-pause',
  deadline: number,
  socketState?: () => number,
) {
  if (!windowsProbeEnabled()) return call();
  const descriptor = Object.getOwnPropertyDescriptor(client, 'response');
  const original = client.response;
  const started = performance.now();
  let response: Response | undefined;
  let responseElapsedMs: number | null = null;
  client.response = async (...args: Parameters<CoreHttp['response']>) => {
    const received = await original.apply(client, args);
    response = received;
    responseElapsedMs = performance.now() - started;
    return received;
  };
  const record = (
    verdict: string,
    body: object | null,
    callElapsedMs: number,
  ) => {
    try {
      writeWindowsProbe(evidence, phase, {
        verdict,
        status: response?.status ?? null,
        callElapsedMs,
        responseElapsedMs,
        beforeSession: safeSession(before),
        body,
        socketState: socketState ? socketState() : null,
      });
    } catch {
      /* Even a failed projection cannot replace the original verdict. */
    }
  };
  try {
    const value = await call();
    record('original-call-passed', null, performance.now() - started);
    return value;
  } catch (error) {
    const callElapsedMs = performance.now() - started;
    let body: object = { status: 'observer-error', code: 'UNKNOWN' };
    try {
      body = await failedHttpCode(
        response,
        expected,
        Math.max(0, Math.min(250, deadline - performance.now() - 5)),
      );
    } catch {
      /* Stream setup errors preserve the original error too. */
    }
    record('original-call-failed', body, callElapsedMs);
    throw error;
  } finally {
    if (descriptor) Object.defineProperty(client, 'response', descriptor);
    else delete (client as Partial<CoreHttp>).response;
  }
}

export type RestartPhase =
  | 'stop-requested'
  | 'old-child-exited'
  | 'spawn-event'
  | 'identity-start'
  | 'identity-complete'
  | 'ready-wait'
  | 'ready-passed'
  | 'ready-failed';
export type RestartObservation = {
  exitCode: number | null;
  signalCode: string | null;
  claimedOwnerProof: boolean;
  kernelProof: boolean;
  proofPidMatches: boolean;
  proofExecutableMatches: boolean;
  healthPolls: number;
  lastHealthStatus: number | null;
  lastHealthError:
    | 'AbortError'
    | 'TimeoutError'
    | 'TypeError'
    | 'child-exited'
    | 'UNKNOWN'
    | null;
};
export type AckPhase =
  | 'control'
  | 'send'
  | 'ack'
  | 'close'
  | 'receive-start'
  | 'receive-ack'
  | 'receive-failed'
  | 'fault'
  | 'boundary-failed';
export type AckObservation = {
  kind?: number;
  packetSequence?: number;
  sourceSequence?: number;
  eventSequence?: number;
  socketState?: number;
  closeCode?: number;
  code?: string;
};
