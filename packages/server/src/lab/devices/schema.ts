import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  bigint,
  boolean,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { labSchema } from '../assets/schema.ts';
import { entities } from '../world/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const runtimeGeneration = labSchema.table(
  'runtime_generation',
  {
    singleton: boolean().primaryKey().default(true),
    generation: bigint({ mode: 'number' }).notNull().default(0),
  },
  (t) => [check('runtime_singleton', sql`${t.singleton}`)],
);
export const bindings = labSchema.table(
  'runtime_bindings',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    programId: text('program_id').notNull(),
    source: text().notNull().unique(),
    current: boolean().notNull().default(true),
    definitionId: text('definition_id').notNull(),
    definitionVersion: text('definition_version').notNull(),
    definition: jsonb().notNull(),
  },
  (t) => [
    uniqueIndex('one_current_binding')
      .on(t.entityId)
      .where(sql`${t.current}`),
  ],
);
export const runs = labSchema.table(
  'program_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    bindingId: uuid('binding_id')
      .notNull()
      .references(() => bindings.id),
    generation: bigint({ mode: 'number' }).notNull(),
    configuration: jsonb().notNull(),
    status: text().notNull(),
    startedBy: uuid('started_by')
      .notNull()
      .references(() => users.id),
    startedAt: instant('started_at').notNull().defaultNow(),
    endedAt: instant('ended_at'),
    sequence: bigint({ mode: 'number' }).notNull().default(0),
    lastObservedAt: instant('last_observed_at'),
    nextSampleAt: instant('next_sample_at'),
  },
  (t) => [
    check(
      'run_status',
      sql`${t.status} IN ('running','stopped','interrupted')`,
    ),
    uniqueIndex('one_running_program')
      .on(t.entityId)
      .where(sql`${t.status} = 'running'`),
    index('program_runs_entity').on(
      t.entityId,
      t.startedAt.desc(),
      t.id.desc(),
    ),
  ],
);
export const commands = labSchema.table(
  'device_commands',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    actorSource: text('actor_source').notNull(),
    requestKey: text('request_key').notNull(),
    capability: text().notNull(),
    parameters: jsonb().notNull(),
    status: text().notNull(),
    result: jsonb(),
    taskId: uuid('task_id'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('command_actor_source', sql`${t.actorSource} IN ('member','agent')`),
    check(
      'command_status',
      sql`${t.status} IN ('accepted','executing','succeeded','failed','unknown')`,
    ),
    uniqueIndex('command_request').on(t.actorId, t.entityId, t.requestKey),
    index('pending_device_commands')
      .on(t.createdAt, t.id)
      .where(sql`${t.status} = 'accepted'`),
    index('device_commands_range').on(
      t.entityId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);
export const observations = labSchema.table('current_observations', {
  entityId: uuid('entity_id')
    .primaryKey()
    .references(() => entities.id),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id),
  sequence: bigint({ mode: 'number' }).notNull(),
  source: text().notNull(),
  values: jsonb().notNull(),
  observedAt: instant('observed_at'),
  receivedAt: instant('received_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
  quality: text().notNull(),
  properties: jsonb().notNull().default({}),
  observedTimes: jsonb('observed_times').notNull().default({}),
  freshness: text().notNull().default('current'),
});
export const tasks = labSchema.table(
  'device_tasks',
  {
    id: uuid().primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    commandId: uuid('command_id').notNull().unique(),
    resultId: uuid('result_id').notNull().unique(),
    parameters: jsonb().notNull(),
    status: text().notNull(),
    elapsedSeconds: doublePrecision('elapsed_seconds').notNull().default(0),
    timerStartedAt: instant('timer_started_at'),
    lastTickAt: instant('last_tick_at'),
    pendingOutcome: text('pending_outcome'),
    createdAt: instant('created_at').notNull().defaultNow(),
    endedAt: instant('ended_at'),
  },
  (t) => [
    check(
      'task_status',
      sql`${t.status} IN ('pending','preparing','running','decelerating','completed','cancelled','failed','unknown','interrupted')`,
    ),
    check('task_elapsed', sql`${t.elapsedSeconds} >= 0`),
    check(
      'task_outcome',
      sql`${t.pendingOutcome} IN ('completed','cancelled','failed','unknown')`,
    ),
    uniqueIndex('one_active_device_task')
      .on(t.entityId)
      .where(
        sql`${t.status} IN ('pending','preparing','running','decelerating')`,
      ),
    index('device_tasks_entity').on(
      t.entityId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);
export const taskResults = labSchema.table(
  'device_task_results',
  {
    id: uuid().primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    status: text().notNull(),
    reason: text(),
    endedAt: instant('ended_at'),
  },
  (t) => [
    check(
      'task_result_status',
      sql`${t.status} IN ('pending','completed','cancelled','failed','unknown','interrupted')`,
    ),
  ],
);
export const commandReceipts = labSchema.table(
  'command_receipts',
  {
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    requestKey: text('request_key').notNull(),
    commandId: uuid('command_id').notNull().unique(),
    fingerprint: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.entityId, t.requestKey] }),
    check('receipt_fingerprint', sql`length(${t.fingerprint}) = 64`),
  ],
);
