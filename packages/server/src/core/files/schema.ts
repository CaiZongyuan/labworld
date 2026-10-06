import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  bigint,
  check,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { coreSchema, users } from '../identity/schema.ts';
import { instant, bytea } from '../../platform/db/columns.ts';
// Local content references; no S3 bucket, worker lease, or removed Job foreign keys.
export const files = coreSchema.table(
  'files',
  {
    id: uuid().primaryKey().defaultRandom(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
    sha256: bytea().notNull(),
    state: text().notNull().default('pending_upload'),
    stagingKey: text('staging_key').notNull().unique(),
    readyKey: text('ready_key'),
    readyCandidateId: uuid('ready_candidate_id').unique(),
    actualSize: bigint('actual_size', { mode: 'number' }),
    expiresAt: instant('expires_at').notNull(),
    lastError: text('last_error'),
    nextCleanupCheckAt: instant('next_cleanup_check_at').notNull().defaultNow(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('file_size', sql`${t.declaredSize} >= 0`),
    check('file_hash', sql`octet_length(${t.sha256}) = 32`),
    check(
      'file_state',
      sql`${t.state} IN ('pending_upload','ready','rejected','expired','deleting','deleted')`,
    ),
    check(
      'ready_file',
      sql`${t.state} <> 'ready' OR (${t.readyKey} IS NOT NULL AND ${t.readyCandidateId} IS NOT NULL AND ${t.actualSize} IS NOT NULL)`,
    ),
    index('files_cleanup').on(t.state, t.expiresAt, t.id),
    index('files_cleanup_check').on(t.nextCleanupCheckAt, t.id),
  ],
);
export const fileReferences = coreSchema.table(
  'file_references',
  {
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.ownerType, t.ownerId] })],
);
export const fileCandidates = coreSchema.table(
  'file_candidates',
  {
    id: uuid().primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    objectKey: text('object_key').notNull().unique(),
    state: text().notNull().default('copying'),
    lastError: text('last_error'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'candidate_state',
      sql`${t.state} IN ('copying','adopted','abandoned','deleted')`,
    ),
    index('file_candidates_file').on(t.fileId, t.id),
  ],
);
export const objectCleanup = coreSchema.table(
  'object_cleanup',
  {
    objectKey: text('object_key').primaryKey(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    candidateId: uuid('candidate_id').references(() => fileCandidates.id),
    firstDeletedAt: instant('first_deleted_at'),
    lastCheckedAt: instant('last_checked_at'),
    nextProbeAt: instant('next_probe_at'),
    lastError: text('last_error'),
  },
  (t) => [
    index('object_cleanup_file').on(t.fileId, t.firstDeletedAt),
    index('object_cleanup_probe')
      .on(t.nextProbeAt)
      .where(sql`${t.firstDeletedAt} IS NOT NULL`),
  ],
);
export const fileCleanupControl = coreSchema.table(
  'file_cleanup_control',
  {
    id: bigint({ mode: 'number' }).primaryKey(),
    lastRescanAt: instant('last_rescan_at'),
  },
  (t) => [check('file_cleanup_singleton', sql`${t.id} = 1`)],
);
