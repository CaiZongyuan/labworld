import type { DbOperation, DbSession } from '../../platform/db/index.ts';

export type RecordingCaptureScope = {
  lab?: string;
  entity?: string;
  run?: string;
};

/** Only current, DB-only ordinary Device Program mutations cross this seam. */
export interface RecordingCapture {
  /** Cheap owner inventory, so the no-Recording path keeps its existing SQL budget. */
  hasActiveRecordings(): boolean;
  covers(entityId: string): boolean;
  transaction<T>(
    operation: DbOperation,
    scope: RecordingCaptureScope,
    work: (tx: DbSession) => Promise<T>,
    /** Recheck the real current actor capability after the file preparation wait. */
    validate?: (tx: DbSession) => Promise<unknown>,
  ): Promise<T>;
}
