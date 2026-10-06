import { sql } from 'drizzle-orm';
import {
  integer,
  text,
  boolean,
  uuid,
  bigint,
  check,
} from 'drizzle-orm/pg-core';
import { coreSchema, users } from '../identity/schema.ts';
export const organizations = coreSchema.table(
  'organizations',
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    ownerInitialized: boolean('owner_initialized').notNull().default(false),
  },
  (t) => [check('single_organization', sql`${t.id} = 1`)],
);
export const memberships = coreSchema.table(
  'memberships',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id),
    role: text().notNull(),
    active: boolean().notNull().default(true),
    version: bigint({ mode: 'number' }).notNull().default(1),
  },
  (t) => [
    check('membership_role', sql`${t.role} IN ('owner','admin','member')`),
    check('membership_version', sql`${t.version} > 0`),
  ],
);
