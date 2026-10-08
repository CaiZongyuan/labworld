import { sql } from 'drizzle-orm';
import {
  uuid,
  text,
  bigint,
  jsonb,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { labSchema } from '../assets/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const guideProgress = labSchema.table(
  'guide_progress',
  {
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    guideId: text('guide_id').notNull(),
    guideVersion: text('guide_version').notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    status: text().notNull(),
    step: text(),
    guideAttemptId: uuid('guide_attempt_id'),
    context: jsonb(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.guideId, t.guideVersion] }),
    check('guide_revision', sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      'guide_status',
      sql`${t.status} IN ('not_started','in_progress','paused','completed')`,
    ),
    check(
      'guide_context',
      sql`${t.context} IS NULL OR (jsonb_typeof(${t.context})='object' AND octet_length(${t.context}::text)<=4096)`,
    ),
    index('guide_previous_progress').on(
      t.actorId,
      t.guideId,
      t.updatedAt.desc(),
    ),
  ],
);
