import { uuid, text, numeric, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { labSchema } from '../assets/schema.ts';
import { labs } from '../world/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { machines } from '../../core/machines/schema.ts';
import { instant } from '../../platform/db/columns.ts';

export const sources = labSchema.table(
  'sources',
  {
    id: uuid().primaryKey().defaultRandom(),
    labId: uuid('lab_id')
      .notNull()
      .references(() => labs.id),
    name: text().notNull(),
    machineId: uuid('machine_id').references(() => machines.id),
    sourceRunId: uuid('source_run_id'),
    connectionId: uuid('connection_id'),
    epoch: numeric({ precision: 20, scale: 0 }).notNull().default('0'),
    phase: text(),
    lastSeenAt: instant('last_seen_at'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sources_lab').on(t.labId, t.id),
    check('source_name', sql`length(btrim(${t.name})) between 1 and 120`),
    check('source_epoch', sql`${t.epoch} between 0 and 18446744073709551615`),
    check('source_phase', sql`${t.phase} in ('initializing','ready')`),
  ],
);
