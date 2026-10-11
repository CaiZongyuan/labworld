import type {
  RecordingAck,
  RecordingBootstrap,
  RecordingHello,
  RecordingReady,
} from '../../../../contracts/src/recording/index.ts';
import type { Session } from '../sessions/dto.ts';

/** Internal capability; only the same persisted machine lease can obtain it. */
export type RecordingSourceScope = {
  bootstrap: Omit<
    RecordingBootstrap,
    'ticket' | 'websocket_path' | 'expires_in_seconds'
  >;
  session: Session;
};

export type RecordingSourceConnection = {
  /** Returned only after the verified nonsecret source header has been synced. */
  ready: RecordingReady;
  /** All ACKs come from the journal's actual synced contiguous prefix. */
  receive: (raw: Uint8Array) => Promise<RecordingAck>;
  /** Admitted connection loss fences its own experiment, never another Session. */
  leave: (reason: string) => void;
};

/** The WS adapter owns parsing/socket quotas; this capability owns durable facts. */
export interface RecordingSourceAuthority {
  consume(ticket: string, recordingId: string): Promise<RecordingSourceScope>;
  bind(
    scope: RecordingSourceScope,
    hello: RecordingHello,
  ): Promise<RecordingSourceConnection>;
  fault(scope: RecordingSourceScope, reason: string): void;
}

/** Server facts have independent identities and no borrowed physics timestamp. */
export type RecordingBusinessEvent = {
  event_id: string;
  event_type:
    | 'program.changed'
    | 'command.changed'
    | 'task.changed'
    | 'observation.report'
    | 'session.changed';
  entity_id: string | null;
  recorded_at: string;
  sim_time_ns: null;
  event: Record<string, unknown>;
};

/** Harness composition only: no production HTTP fault route or environment switch. */
export type RecordingFaults = {
  beforeWrite?: (recordingId: string, kind: string) => Promise<void>;
  beforeSync?: (recordingId: string, kind: string) => Promise<void>;
  beforePublish?: (recordingId: string, segmentId: string) => Promise<void>;
  prepared?: (recordingId: string, batchId: string) => Promise<void>;
  committed?: (recordingId: string, batchId: string) => Promise<void>;
};

/** Harness hooks cannot retain an admitted writer forever or resume its I/O after timeout. */
export async function waitRecordingFault(
  work: Promise<void> | undefined,
  millis: number,
) {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('recording_hook_timeout')),
          millis,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
