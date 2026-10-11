import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../../apps/server/src/runtime.ts';
import {
  readRecordingRecords,
  type RecordingRecord,
} from './recording-wire-oracle.ts';

// This entry is launched only by the isolated ServerProcess test supervisor.
// Faults are armed over its private IPC channel; production has no such route.
assert(process.send, 'Launch this fixture through the owned IPC supervisor');
type Arm = {
  point: 'beforeWrite' | 'beforeSync' | 'prepared' | 'committed';
  mode: 'fail' | 'block';
  kind?: string;
  event_type?: string;
  status?: string;
};
let arm: Arm | undefined;
let release: (() => void) | undefined;
let executionHeld = false;
let releaseExecution: (() => void) | undefined;

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
        event: Record<string, Record<string, unknown>>;
      }[];
      if (
        !events.some(
          (event) =>
            event.event_type === current.event_type &&
            (!current.status ||
              ['command', 'task', 'program'].some(
                (key) => event.event[key]?.status === current.status,
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
  (message: { operation: string; fault?: Arm; held?: boolean }) => {
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
    }
  },
);

await run(undefined, {
  recordingFaults: {
    beforeWrite: (recording: string, kind: string) =>
      fault('beforeWrite', recording, kind),
    beforeSync: (recording: string, kind: string) =>
      fault('beforeSync', recording, kind),
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
  });
