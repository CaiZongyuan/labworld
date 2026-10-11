import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreHttp } from './core-http.ts';

// Numeric stages: select 1/2, encode 3/4, decode 5/6, prefix 7/8,
// exchange 9, first send 10, retry 11, response 12, close 13, error 14, expiry 15;
// Motion close/error 16/17. Times measure client operations, not server/wire causality.
export class RecordingReceiptTrace {
  private start = performance.now();
  private rows: [number, number, number][] = [];
  expectedPrefix: string | null = null;
  mark(stage: number, value = 0) {
    if (this.rows.length === 16) this.rows.shift();
    this.rows.push([
      Number.isSafeInteger(stage) && stage >= 1 && stage <= 17 ? stage : 0,
      Math.round((performance.now() - this.start) * 1000) / 1000,
      Number.isSafeInteger(value) ? value : 0,
    ]);
  }
  response(text: string) {
    try {
      const value = JSON.parse(text);
      const types = ['recording.ack', 'recording.error', 'recording.ready'];
      const codes = [
        'recording_invalid_packet',
        'recording_source_prefix_mismatch',
        'recording_durability_timeout',
        'recording_unavailable',
      ];
      this.mark(
        12,
        (types.indexOf(value.type) + 1) * 100 + codes.indexOf(value.code) + 1,
      );
    } catch {
      this.mark(12);
    }
  }
  snapshot() {
    return {
      rows: this.rows.map((row) => [...row]),
      expected_prefix: digest(this.expectedPrefix),
    };
  }
}
const decimal = (value: unknown) =>
  typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
const digest = (value: unknown) =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
    ? value
    : null;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
export function receiptFacts(value: unknown, recording: boolean) {
  const row = object(value),
    prefix = object(row.prefix);
  const states = recording
    ? ['preparing', 'open', 'complete', 'incomplete', 'deleting', 'deleted']
    : [
        'starting',
        'running',
        'pausing',
        'paused',
        'resuming',
        'stopping',
        'stopped',
        'interrupted',
        'reset',
      ];
  return {
    status:
      typeof row.status === 'string' && states.includes(row.status)
        ? row.status
        : null,
    epoch: recording ? null : decimal(row.epoch),
    source_packet_sequence: recording
      ? decimal(prefix.source_packet_sequence)
      : null,
    last_source_sequence: recording
      ? decimal(prefix.last_source_sequence)
      : null,
    last_source_event_sequence: recording
      ? decimal(prefix.last_source_event_sequence)
      : null,
    last_sim_time_ns: recording ? decimal(prefix.last_sim_time_ns) : null,
    source_prefix_sha256: recording
      ? digest(prefix.source_prefix_sha256)
      : null,
    source_ended:
      recording && typeof prefix.source_ended === 'boolean'
        ? prefix.source_ended
        : null,
  };
}
const errorCodes = [
  'lab.publisher_capacity',
  'lab.recording_unavailable',
  'lab.recording_prepare_timeout',
  'lab.recording_read_timeout',
  'lab.source_unavailable',
  'files.unavailable',
  'internal.unavailable',
  'identity.machine_unauthorized',
  'database.unavailable',
  'auth.unavailable',
  'internal.error',
];
export const admissionCode = (value: unknown) =>
  errorCodes.indexOf(String(object(object(value).error).code)) + 1;
const number = (value: unknown) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1e9
    ? value
    : 0;
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
    ? value
    : null;
export function serverPhases(log: string) {
  const rows: number[][] = [];
  const bytes = Buffer.from(log, 'utf8');
  const start = Math.max(0, bytes.length - 65536);
  const lines = bytes.subarray(start).toString('utf8').split('\n');
  // A byte tail can start inside a multibyte character or a JSON line.
  if (start > 0 && bytes[start - 1] !== 10) lines.shift();
  for (const line of lines.slice(-128)) {
    try {
      const row = object(JSON.parse(line));
      const category =
        [
          'database.operation',
          'http.request',
          'sessions.source_failed',
          'sessions.tick_failed',
          'server.ready',
          'server.start_failed',
          'server.close_failed',
        ].indexOf(String(row.event)) + 1;
      if (!category) continue;
      if (rows.length === 16) rows.shift();
      rows.push([
        category,
        number(row.status),
        row.outcome === 'error' ? 2 : row.outcome === 'ok' ? 1 : 0,
        number(row.durationMs ?? row.duration_ms),
        number(row.queueWaitMs),
        number(row.statements),
        typeof row.path === 'string' &&
        row.path.endsWith('/publisher-admissions')
          ? 1
          : 0,
      ]);
    } catch {
      /* No raw log text retained. */
    }
  }
  return rows;
}
async function boundedJSON(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader || signal.aborted) throw new Error('Diagnostic body unavailable');
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (!signal.aborted) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) {
        cancel();
        throw new Error('Diagnostic body limit');
      }
      chunks.push(part.value);
    }
    if (signal.aborted) throw new Error('Diagnostic body deadline');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
export type PrerequisiteDiagnostic = {
  phase: number;
  nonce: string;
  sessionId?: string;
  response?: Response;
  logs: string;
};
// Called only after the original exception; a new independent 2s diagnostic budget.
export async function writeRecordingReceipt(
  evidence: string,
  trace: RecordingReceiptTrace,
  error: unknown,
  client: CoreHttp,
  sessionPath: string | undefined,
  recordingPath: string | undefined,
  prerequisite?: PrerequisiteDiagnostic,
) {
  const snapshot = trace.snapshot();
  const signal = AbortSignal.timeout(2000);
  const read = async (path: string | undefined, recording: boolean) => {
    try {
      if (!path) throw new Error('Diagnostic scope unavailable');
      const response = await fetch(client.url + path, {
        headers: { cookie: client.cookie ?? '', origin: client.url },
        signal,
      });
      let value = await boundedJSON(response, signal);
      if (recording && Array.isArray(object(value).data))
        value = (object(value).data as unknown[]).find(
          (item) => object(item).session_id === prerequisite?.sessionId,
        );
      return {
        http_status: response.status,
        ...receiptFacts(value, recording),
      };
    } catch {
      return { http_status: 0, ...receiptFacts(null, recording) };
    }
  };
  const decodeAdmission = async () => {
    try {
      return admissionCode(
        await boundedJSON(prerequisite!.response!.clone(), signal),
      );
    } catch {
      return 0;
    }
  };
  const readOwner = async () => {
    try {
      const ledger = JSON.parse(
        await readFile(join(evidence, 'owned-resources.json'), {
          encoding: 'utf8',
          signal,
        }),
      );
      return uuid(ledger.runId);
    } catch {
      return null;
    }
  };
  const [session, recording, code, owner] = await Promise.all([
    read(sessionPath, false),
    read(recordingPath, true),
    decodeAdmission(),
    readOwner(),
  ]);
  const exceptions = [
    'Recording receipt deadline exceeded',
    'Recording total receipt deadline already expired',
    'Recording socket closed',
    'Recording socket error',
  ];
  await writeFile(
    join(evidence, 'recording-u64-diagnostic.json'),
    JSON.stringify({
      trace: snapshot,
      facts: {
        classification:
          prerequisite && prerequisite.phase < 9
            ? 'FAILED_PREREQUISITE_OR_UNCLASSIFIED'
            : 'FAILED_RECORDING_OR_UNCLASSIFIED',
        phase: prerequisite?.phase ?? 9,
        current_nonce: uuid(prerequisite?.nonce),
        owner_run_id: owner,
        admission: {
          http_status: prerequisite?.response?.status ?? 0,
          error_code: code,
        },
        first_assertion: {
          expected: number(object(error).expected),
          actual: number(object(error).actual),
          strict_equal: object(error).operator === 'strictEqual',
        },
        first_exception:
          exceptions.indexOf(error instanceof Error ? error.message : '') + 1,
        session,
        recording,
      },
    }) + '\n',
    { signal: AbortSignal.timeout(1000) },
  );
  await writeFile(
    join(evidence, 'recording-u64-server-phases.json'),
    JSON.stringify({
      current_nonce: uuid(prerequisite?.nonce),
      phases: serverPhases(prerequisite?.logs ?? ''),
    }) + '\n',
    { signal: AbortSignal.timeout(1000) },
  );
}
