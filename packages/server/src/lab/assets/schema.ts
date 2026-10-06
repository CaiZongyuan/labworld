import { sql } from 'drizzle-orm';
import { pgSchema, uuid, text, bigint, check } from 'drizzle-orm/pg-core';
import { users } from '../../core/identity/schema.ts';
import { files } from '../../core/files/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const labSchema = pgSchema('lab');
export const assetUploads = labSchema.table('asset_uploads', {
  uploadId: uuid('upload_id')
    .primaryKey()
    .references(() => files.id),
  assetId: uuid('asset_id').notNull().unique(),
  name: text().notNull(),
  source: text().notNull(),
  license: text().notNull(),
  version: text().notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
});
export const assets = labSchema.table(
  'assets',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    source: text().notNull(),
    license: text().notNull(),
    version: text().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [check('asset_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 120`)],
);
export const representations = labSchema.table('asset_representations', {
  id: uuid().primaryKey().defaultRandom(),
  assetId: uuid('asset_id')
    .notNull()
    .unique()
    .references(() => assets.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id')
    .notNull()
    .unique()
    .references(() => files.id),
  fileName: text('file_name').notNull(),
  size: bigint({ mode: 'number' }).notNull(),
  sha256: text().notNull(),
  contentType: text('content_type').notNull(),
});
