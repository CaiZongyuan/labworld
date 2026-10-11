import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  jsonb,
  integer,
  numeric,
  bigint,
  boolean,
  primaryKey,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { labSchema } from '../assets/schema.ts';
import { labs } from '../world/schema.ts';
import { simulationSessions } from '../sessions/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { files } from '../../core/files/schema.ts';
import { instant } from '../../platform/db/columns.ts';

export const recordings = labSchema.table(
  'recordings',
  {
    id: uuid().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .unique()
      .references(() => simulationSessions.id),
    labId: uuid('lab_id')
      .notNull()
      .references(() => labs.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    snapshotHash: text('snapshot_hash').notNull(),
    manifestFileId: uuid('manifest_file_id').references(() => files.id),
    manifestSha256: text('manifest_sha256'),
    captureEntityIds: jsonb('capture_entity_ids').notNull(),
    status: text().notNull().default('preparing'),
    reason: text(),
    startedAt: instant('started_at').notNull(),
    endedAt: instant('ended_at'),
    eventSequence: numeric('event_sequence', { precision: 20, scale: 0 })
      .notNull()
      .default('0'),
    checkpoint: jsonb().notNull().default({}),
    chargedBytes: bigint('charged_bytes', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (t) => [
    check(
      'recording_status',
      sql`${t.status} in ('preparing','open','complete','incomplete','deleting','deleted')`,
    ),
    check(
      'recording_event_sequence',
      sql`${t.eventSequence} between 0 and 18446744073709551615`,
    ),
    check('recording_charge', sql`${t.chargedBytes}>=0`),
  ],
);
export const recordingResources = labSchema.table(
  'recording_resources',
  {
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    role: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.recordingId, t.fileId] })],
);
export const recordingSegments = labSchema.table(
  'recording_segments',
  {
    id: uuid().primaryKey(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id),
    index: integer().notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    size: integer().notNull(),
    sha256: text().notNull(),
    firstOrdinal: numeric('first_ordinal', {
      precision: 20,
      scale: 0,
    }).notNull(),
    lastOrdinal: numeric('last_ordinal', { precision: 20, scale: 0 }).notNull(),
  },
  (t) => [
    uniqueIndex('recording_segment_index').on(t.recordingId, t.index),
    check('recording_segment_size', sql`${t.size}>0`),
  ],
);
export const recordingEventCommits = labSchema.table(
  'recording_event_commits',
  {
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id),
    batchId: uuid('batch_id').notNull(),
    firstEventSequence: numeric('first_event_sequence', {
      precision: 20,
      scale: 0,
    }).notNull(),
    eventCount: integer('event_count').notNull(),
    sha256: text().notNull(),
    committedAt: instant('committed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordingId, t.batchId] }),
    uniqueIndex('recording_event_first').on(
      t.recordingId,
      t.firstEventSequence,
    ),
    check('recording_event_count', sql`${t.eventCount} between 1 and 256`),
  ],
);
/** Future Session IDs have no FK until the atomic Reset handoff adopts this stage. */
export const recordingStages = labSchema.table('recording_stages', {
  id: uuid().primaryKey(),
  sessionId: uuid('session_id').notNull().unique(),
  labId: uuid('lab_id')
    .notNull()
    .references(() => labs.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  manifestFileId: uuid('manifest_file_id').references(() => files.id),
  manifestSha256: text('manifest_sha256'),
  chargedBytes: bigint('charged_bytes', { mode: 'number' }).notNull(),
  createdAt: instant('created_at').notNull(),
  headerSynced: boolean('header_synced').notNull().default(false),
});
