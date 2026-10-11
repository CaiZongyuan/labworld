import { uuid, text, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { coreSchema, users } from '../identity/schema.ts';
import { instant } from '../../platform/db/columns.ts';
/** Independent service identity. No Lab foreign key belongs in Platform Core. */
export const machines = coreSchema.table(
  'machines',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    credentialHash: text('credential_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull().defaultNow(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
  },
  (t) => [
    check('machine_name', sql`length(btrim(${t.name})) between 1 and 120`),
  ],
);
