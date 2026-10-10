import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  jsonb,
  integer,
  numeric,
  boolean,
  check,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { labSchema, representations } from '../assets/schema.ts';
import { labs, entities, sceneNodes } from '../world/schema.ts';
import { machines } from '../../core/machines/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { files } from '../../core/files/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const installations = labSchema.table('scene_installations', {
  id: uuid().primaryKey().defaultRandom(),
  labId: uuid('lab_id')
    .notNull()
    .references(() => labs.id),
  metadata: jsonb().notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: instant('created_at').notNull().defaultNow(),
  archivedAt: instant('archived_at'),
});
export const simulationSessions = labSchema.table(
  'simulation_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    labId: uuid('lab_id')
      .notNull()
      .references(() => labs.id),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    snapshot: jsonb().notNull(),
    status: text().notNull(),
    revision: integer().notNull().default(0),
    epoch: numeric({ precision: 20, scale: 0 }),
    leaseId: uuid('lease_id'),
    startedBy: uuid('started_by')
      .notNull()
      .references(() => users.id),
    startedAt: instant('started_at').notNull().defaultNow(),
    endedAt: instant('ended_at'),
    reason: text(),
    successorSessionId: uuid('successor_session_id'),
  },
  (t) => [
    uniqueIndex('one_active_simulation_session')
      .on(t.labId)
      .where(sql`${t.endedAt} is null`),
    check(
      'simulation_session_status',
      sql`${t.status} in ('starting','running','pausing','paused','resuming','stopping','stopped','interrupted','reset')`,
    ),
    check('simulation_session_revision', sql`${t.revision} >= 0`),
    check(
      'simulation_session_epoch',
      sql`${t.epoch} between 1 and 18446744073709551615`,
    ),
  ],
);
export const publisherLeases = labSchema.table(
  'publisher_leases',
  {
    id: uuid().primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => simulationSessions.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    epoch: numeric({ precision: 20, scale: 0 }).notNull().unique(),
    admittedAt: instant('admitted_at').notNull().defaultNow(),
    endedAt: instant('ended_at'),
  },
  (t) => [
    uniqueIndex('one_active_publisher_lease')
      .on(t.sessionId)
      .where(sql`${t.endedAt} is null`),
    check(
      'publisher_epoch_u64',
      sql`${t.epoch} between 1 and 18446744073709551615`,
    ),
  ],
);
export const publisherEpoch = labSchema.table(
  'publisher_epoch',
  {
    singleton: boolean().primaryKey().default(true),
    value: numeric({ precision: 20, scale: 0 }).notNull().default('0'),
  },
  (t) => [
    check('publisher_epoch_singleton', sql`${t.singleton}`),
    check(
      'publisher_counter_u64',
      sql`${t.value} between 0 and 18446744073709551615`,
    ),
  ],
);
/** Exists only while a Session owns these structural identities. Node FK is deferred in migration. */
export const sessionObjects = labSchema.table(
  'session_objects',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => simulationSessions.id),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => sceneNodes.id),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.nodeId] })],
);
/** Retained immutable snapshot references keep exact asset versions and ready bytes available. */
export const sessionAssets = labSchema.table(
  'session_assets',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => simulationSessions.id),
    representationId: uuid('representation_id')
      .notNull()
      .references(() => representations.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.representationId] })],
);
