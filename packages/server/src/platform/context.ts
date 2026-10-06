import type { Database, DbSession } from './db/index.ts';

export interface Clock {
  now(): string;
}
export interface BlobStore {
  stage(
    content: AsyncIterable<Uint8Array>,
    maximumBytes: number,
  ): Promise<{ key: string; sha256: string; size: number }>;
  adopt(stagedKey: string, sha256: string): Promise<string>;
  read(key: string): AsyncIterable<Uint8Array>;
  remove(key: string): Promise<void>;
}
export type AuditRecord = {
  actorId?: string;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId?: string;
  correlationId: string;
  metadata: Record<string, string>;
};
export interface Audit {
  record(transaction: DbSession, event: AuditRecord): Promise<void>;
}
export interface Events {
  publish(event: {
    topic: string;
    revision: number;
    data: unknown;
  }): Promise<void>;
}
export interface UseCaseContext {
  db: Database;
  clock: Clock;
  blobs: BlobStore;
  audit: Audit;
  events: Events;
}
// M1 composes only implemented capabilities; M2 supplies the actual local BlobStore/audit.
export type FoundationContext = Pick<UseCaseContext, 'db' | 'clock'>;
