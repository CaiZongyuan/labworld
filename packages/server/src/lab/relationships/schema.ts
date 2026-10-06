import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  check,
  unique,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { labSchema } from '../assets/schema.ts';
import { labs, entities } from '../world/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const relationships = labSchema.table(
  'entity_relationships',
  {
    id: uuid().primaryKey().defaultRandom(),
    labId: uuid('lab_id')
      .notNull()
      .references(() => labs.id),
    sourceId: uuid('source_id').notNull(),
    targetId: uuid('target_id').notNull(),
    kind: text().notNull(),
    source: text().notNull().default('manual'),
    registeredBy: uuid('registered_by')
      .notNull()
      .references(() => users.id),
    registeredAt: instant('registered_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.labId, t.sourceId],
      foreignColumns: [entities.labId, entities.id],
    }),
    foreignKey({
      columns: [t.labId, t.targetId],
      foreignColumns: [entities.labId, entities.id],
    }),
    check(
      'relationship_kind',
      sql`${t.kind} IN ('located_in','contains','simulates')`,
    ),
    check('relationship_source', sql`${t.source} = 'manual'`),
    check('relationship_distinct', sql`${t.sourceId} <> ${t.targetId}`),
    unique('relationship_unique').on(t.labId, t.sourceId, t.targetId, t.kind),
    index('entity_relationships_lab_id').on(t.labId, t.id),
  ],
);
