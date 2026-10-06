import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  bigint,
  boolean,
  jsonb,
  check,
  unique,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { labSchema, representations } from '../assets/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const labs = labSchema.table(
  'labs',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    layoutVersion: bigint('layout_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [check('lab_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 120`)],
);
export const entities = labSchema.table(
  'entities',
  {
    id: uuid().primaryKey().defaultRandom(),
    labId: uuid('lab_id')
      .notNull()
      .references(() => labs.id),
    name: text().notNull(),
    kind: text().notNull(),
    reality: text().notNull(),
    definitionId: text('definition_id').notNull(),
    definitionVersion: text('definition_version').notNull(),
    definition: jsonb().notNull(),
    configuration: jsonb().notNull(),
    representationId: uuid('representation_id').references(
      () => representations.id,
    ),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
    archivedAt: instant('archived_at'),
  },
  (t) => [
    check('entity_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check('entity_reality', sql`${t.reality} IN ('simulated','physical')`),
    unique('entities_lab_identity').on(t.labId, t.id),
    index('entities_lab_id').on(t.labId, t.id),
  ],
);
export const sceneNodes = labSchema.table(
  'scene_nodes',
  {
    id: uuid().primaryKey().defaultRandom(),
    labId: uuid('lab_id')
      .notNull()
      .references(() => labs.id),
    entityId: uuid('entity_id').notNull(),
    representationId: uuid('representation_id').references(
      () => representations.id,
    ),
    placement: jsonb().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.labId, t.entityId],
      foreignColumns: [entities.labId, entities.id],
    }),
    index('scene_nodes_lab_id').on(t.labId, t.id),
  ],
);
export const worldClock = labSchema.table(
  'world_clock',
  {
    singleton: boolean().primaryKey().default(true),
    version: bigint({ mode: 'number' }).notNull().default(0),
  },
  (t) => [
    check('world_singleton', sql`${t.singleton}`),
    check('world_version_nonnegative', sql`${t.version} >= 0`),
  ],
);
