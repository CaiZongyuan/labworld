import { sql } from 'drizzle-orm';
import { uuid, text, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';
import { coreSchema, users } from '../identity/schema.ts';
import { instant, bytea } from '../../platform/db/columns.ts';
export const idempotencyRecords = coreSchema.table(
  'idempotency_records',
  {
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    scope: text().notNull(),
    requestKey: text('request_key').notNull(),
    fingerprint: bytea().notNull(),
    response: jsonb(),
    expiresAt: instant('expires_at')
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.scope, t.requestKey] }),
    index('idempotency_expiry').on(t.expiresAt),
  ],
);
