import { writeFile } from 'node:fs/promises';
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
// Called only after the original exception; a new independent 2s diagnostic budget.
export async function writeRecordingReceipt(
  evidence: string,
  trace: RecordingReceiptTrace,
  error: unknown,
  client: CoreHttp,
  sessionPath: string,
  recordingPath: string,
) {
  const snapshot = trace.snapshot();
  const signal = AbortSignal.timeout(2000);
  const read = async (path: string, recording: boolean) => {
    try {
      const response = await fetch(client.url + path, {
        headers: { cookie: client.cookie ?? '', origin: client.url },
        signal,
      });
      return {
        http_status: response.status,
        ...receiptFacts(await response.json(), recording),
      };
    } catch {
      return { http_status: 0, ...receiptFacts(null, recording) };
    }
  };
  const [session, recording] = await Promise.all([
    read(sessionPath, false),
    read(recordingPath, true),
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
        first_exception:
          exceptions.indexOf(error instanceof Error ? error.message : '') + 1,
        session,
        recording,
      },
    }) + '\n',
    { signal: AbortSignal.timeout(1000) },
  );
}
