import { sql } from 'drizzle-orm';
import { uuid, text, jsonb, index, check } from 'drizzle-orm/pg-core';
import { coreSchema, users } from '../identity/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const auditEvents = coreSchema.table(
  'audit_events',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    actorId: uuid('actor_id').references(() => users.id),
    actorType: text('actor_type').notNull(),
    action: text().notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    correlationId: text('correlation_id').notNull(),
    metadata: jsonb().notNull().default({}),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('audit_metadata_object', sql`jsonb_typeof(${t.metadata}) = 'object'`),
    check(
      'audit_metadata_allowlist',
      sql`${t.metadata} - 'subject_user_id' = '{}'::jsonb`,
    ),
    index('audit_resource_history').on(t.resourceId, t.id),
    index('audit_action_history').on(t.action, t.id),
    index('audit_actor_history').on(t.actorId, t.id),
    index('audit_request_history').on(t.requestId, t.id),
    index('audit_correlation_history').on(t.correlationId, t.id),
  ],
);
