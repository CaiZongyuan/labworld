import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  jsonb,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { labSchema } from '../assets/schema.ts';
import { entities } from '../world/schema.ts';
import { runs } from '../devices/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const history = labSchema.table(
  'observation_history',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    observedAt: instant('observed_at'),
    receivedAt: instant('received_at').notNull(),
    data: jsonb().notNull(),
  },
  (t) => [
    index('observation_history_range').on(
      t.entityId,
      t.receivedAt.desc(),
      t.id.desc(),
    ),
  ],
);
export const deviceEvents = labSchema.table(
  'device_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    occurredAt: instant('occurred_at').notNull(),
    receivedAt: instant('received_at').notNull().defaultNow(),
    data: jsonb().notNull(),
  },
  (t) => [
    index('device_events_range').on(
      t.entityId,
      t.receivedAt.desc(),
      t.id.desc(),
    ),
  ],
);
export const historyBounds = labSchema.table(
  'history_bounds',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    recordType: text('record_type').notNull(),
    capturedSince: instant('captured_since').notNull(),
    cleanedBefore: instant('cleaned_before'),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.recordType] }),
    check(
      'history_type',
      sql`${t.recordType} IN ('observation','command','task','event')`,
    ),
  ],
);
