import { uuid, text, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { labSchema, assets, representations } from '../assets/schema.ts';
import { files } from '../../core/files/schema.ts';
import { users } from '../../core/identity/schema.ts';
import { instant } from '../../platform/db/columns.ts';
export const assetVersions = labSchema.table(
  'asset_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    assetId: text('asset_id').notNull(),
    namespace: text().notNull(),
    version: text().notNull(),
    contentSha256: text('content_sha256').notNull(),
    definition: jsonb().notNull(),
    representations: jsonb().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('asset_version_identity').on(t.assetId, t.version),
    index('asset_versions_namespace').on(t.namespace, t.id),
  ],
);
export const assetVersionResources = labSchema.table(
  'asset_version_resources',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => assetVersions.id),
    key: text().notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    format: text().notNull(),
    verification: text().notNull(),
    representationId: uuid('representation_id').references(
      () => representations.id,
    ),
    projectedAssetId: uuid('projected_asset_id').references(() => assets.id),
  },
  (t) => [unique('asset_version_resource_key').on(t.versionId, t.key)],
);
export const assetResourceUploads = labSchema.table('asset_resource_uploads', {
  uploadId: uuid('upload_id')
    .primaryKey()
    .references(() => files.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
});
