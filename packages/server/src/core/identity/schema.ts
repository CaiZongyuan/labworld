import { pgSchema, uuid, text, boolean, index } from 'drizzle-orm/pg-core';
import { instant, bytea } from '../../platform/db/columns.ts';
export const coreSchema = pgSchema('labos_threejs_core');
export const users = coreSchema.table('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull(),
  normalizedEmail: text('normalized_email').notNull().unique(),
  displayName: text('display_name'),
  createdAt: instant('created_at').notNull().defaultNow(),
});
export const credentials = coreSchema.table('credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  passwordHash: text('password_hash').notNull(),
});
export const sessions = coreSchema.table(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    secretHash: bytea('secret_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: instant('expires_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull().defaultNow(),
    revoked: boolean().notNull().default(false),
  },
  (t) => [index('sessions_user_id').on(t.userId)],
);
