import { sql } from 'drizzle-orm';
import { uuid, text, index, check } from 'drizzle-orm/pg-core';
import { coreSchema, users } from '../identity/schema.ts';
import { instant, bytea } from '../../platform/db/columns.ts';
export const apiKeys = coreSchema.table(
  'api_keys',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    prefix: text().notNull(),
    secretHash: bytea('secret_hash').notNull().unique(),
    scopes: text().array().notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    lastUsedAt: instant('last_used_at'),
  },
  (t) => [
    check('api_key_name', sql`length(${t.name}) BETWEEN 1 AND 100`),
    check('api_key_scopes', sql`cardinality(${t.scopes}) BETWEEN 1 AND 16`),
    index('api_keys_owner_history').on(t.userId, t.id),
  ],
);
