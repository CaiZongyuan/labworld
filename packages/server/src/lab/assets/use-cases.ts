import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  FileContentRejected,
  type FileService,
} from '../../core/files/use-cases.ts';
import { normalizeUpload } from '../../core/files/domain.ts';
import { accessIn, requireAccess } from '../../core/api-keys/authentication.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import {
  claim,
  complete,
  fingerprint,
  IdempotencyConflict,
  InvalidIdempotencyKey,
} from '../../core/idempotency/use-cases.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import {
  normalizeAssetUpload,
  validText,
  type CreateAssetUpload,
  type LabAsset,
} from './domain.ts';
import { assetUploads, assets, representations } from './schema.ts';
import { canonicalUuid } from '../../platform/uuid.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { validGlb, MAX_DECODED_RESOURCE_BYTES } from './validation.ts';

export async function startAssetUpload(
  files: FileService,
  headers: Headers,
  requestId: string,
  input: CreateAssetUpload,
) {
  try {
    return await files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          files.context,
          files.auth,
          headers,
          'lab:full',
          true,
        );
        const normalized = normalizeAssetUpload(input);
        if (!normalized)
          throw new PublicFailure(
            400,
            'lab.invalid_input',
            'Use valid asset metadata and a GLB file',
          );
        const fileInput = normalizeUpload(normalized.file, files.policy);
        if (fileInput === 'too_large')
          throw new PublicFailure(
            413,
            'files.too_large',
            'File exceeds the allowed size',
          );
        if (!fileInput)
          throw new PublicFailure(
            400,
            'files.invalid_input',
            'Use valid file metadata',
          );
        normalized.file = fileInput;
        const attempt = {
          actorId: actor.user.id,
          scope: 'POST /api/v1/lab/asset-uploads',
          key: headers.get('idempotency-key') ?? '',
          fingerprint: fingerprint(normalized),
        };
        const replay = (await claim(tx, attempt)) as
          { upload_id: string } | undefined;
        if (replay) {
          const [association] = await tx
            .select()
            .from(assetUploads)
            .where(eq(assetUploads.uploadId, replay.upload_id));
          if (!association)
            throw new PublicFailure(
              404,
              'lab.asset_not_found',
              'Asset upload not found',
            );
          return files.uploadCapability(tx, association.uploadId);
        }
        const upload = await files.start(tx, actor, normalized.file);
        const assetId = randomUUID();
        await tx.insert(assetUploads).values({
          uploadId: upload.upload_id,
          assetId,
          name: normalized.name,
          source: normalized.source,
          license: normalized.license,
          version: normalized.version,
          createdBy: actor.user.id,
        });
        await complete(tx, attempt, { upload_id: upload.upload_id });
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'lab.asset.upload_start',
          resourceType: 'lab.asset',
          resourceId: assetId,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return upload;
      },
    );
  } catch (error) {
    if (error instanceof PublicFailure) throw error;
    if (error instanceof IdempotencyConflict)
      throw new PublicFailure(409, 'idempotency.conflict', error.message);
    if (error instanceof InvalidIdempotencyKey)
      throw new PublicFailure(400, 'idempotency.invalid_key', error.message);
    throw new PublicFailure(
      503,
      'lab.unavailable',
      'Lab is temporarily unavailable',
    );
  }
}

const columns = sql`a.id::text,a.name,a.source,a.license,a.version,a.created_by::text,a.updated_by::text,a.created_at,a.updated_at,jsonb_build_object('id',r.id,'file_id',r.file_id,'file_name',r.file_name,'size',r.size,'sha256',r.sha256,'content_type',r.content_type) as representation`;
const join = sql`lab.assets a join lab.asset_representations r on r.asset_id=a.id`;
function assetValue(row: LabAsset): LabAsset {
  return {
    ...row,
    created_at: utcInstant(row.created_at),
    updated_at: utcInstant(row.updated_at),
  };
}
export async function loadAsset(tx: DbSession, id: string) {
  const canonical = canonicalUuid(id);
  if (!canonical)
    throw new PublicFailure(404, 'lab.asset_not_found', 'Asset not found');
  const result = await tx.execute<LabAsset>(
    sql`select ${columns} from ${join} where a.id=${canonical}::uuid`,
  );
  if (!result.rows[0])
    throw new PublicFailure(404, 'lab.asset_not_found', 'Asset not found');
  return assetValue(result.rows[0]);
}
function failure(error: unknown): never {
  if (error instanceof PublicFailure) throw error;
  throw new PublicFailure(
    503,
    'lab.unavailable',
    'Lab is temporarily unavailable',
  );
}
async function association(tx: DbSession, id: string) {
  const canonical = canonicalUuid(id);
  if (!canonical)
    throw new PublicFailure(
      404,
      'lab.asset_not_found',
      'Asset upload not found',
    );
  const [row] = await tx
    .select()
    .from(assetUploads)
    .where(eq(assetUploads.uploadId, canonical));
  if (!row)
    throw new PublicFailure(
      404,
      'lab.asset_not_found',
      'Asset upload not found',
    );
  return row;
}
export async function completeAssetUpload(
  files: FileService,
  headers: Headers,
  requestId: string,
  id: string,
) {
  try {
    const actor = await requireAccess(
      files.context,
      files.auth,
      headers,
      requestId,
      'lab:full',
      true,
    );
    await files.context.db.read({ id: requestId, kind: 'request' }, (tx) =>
      association(tx, id),
    );
    return await files.complete(
      actor,
      id,
      requestId,
      async (tx, file, transitioned) => {
        const upload = await association(tx, file.id);
        if (transitioned) {
          await tx.insert(assets).values({
            id: upload.assetId,
            name: upload.name,
            source: upload.source,
            license: upload.license,
            version: upload.version,
            createdBy: upload.createdBy,
            updatedBy: actor.user.id,
          });
          const [representation] = await tx
            .insert(representations)
            .values({
              assetId: upload.assetId,
              fileId: file.id,
              fileName: file.file_name,
              size: file.size,
              sha256: file.sha256,
              contentType: file.content_type,
            })
            .returning();
          await files.pin(tx, file.id, {
            ownerType: 'lab.asset_representation',
            ownerId: representation.id,
          });
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: actor.isApiKey ? 'agent' : 'user',
            action: 'lab.asset.publish',
            resourceType: 'lab.asset',
            resourceId: upload.assetId,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
        }
        return loadAsset(tx, upload.assetId);
      },
      async (candidate) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of candidate.read()) chunks.push(chunk);
        if (!(await validGlb(Buffer.concat(chunks))))
          throw new FileContentRejected(
            'GLB content validation refused the immutable candidate',
          );
      },
    );
  } catch (error) {
    failure(error);
  }
}
export async function getAsset(
  files: FileService,
  headers: Headers,
  requestId: string,
  id: string,
) {
  try {
    return await files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(tx, files.context, files.auth, headers, 'lab:full');
        return loadAsset(tx, id);
      },
    );
  } catch (error) {
    failure(error);
  }
}
export async function downloadAsset(
  files: FileService,
  headers: Headers,
  requestId: string,
  id: string,
) {
  try {
    return await files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          files.context,
          files.auth,
          headers,
          'lab:full',
        );
        const asset = await loadAsset(tx, id);
        return files.download(tx, actor, asset.representation.file_id);
      },
    );
  } catch (error) {
    failure(error);
  }
}

export async function listAssets(
  files: FileService,
  headers: Headers,
  requestId: string,
  query: { limit?: number; cursor?: string },
) {
  try {
    return await files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(tx, files.context, files.auth, headers, 'lab:full');
        const limit = query.limit ?? 50,
          cursor =
            query.cursor === undefined
              ? undefined
              : canonicalUuid(query.cursor);
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (query.cursor !== undefined && !cursor)
        )
          throw new PublicFailure(
            400,
            'lab.invalid_input',
            'Use valid asset pagination',
          );
        const result = await tx.execute<LabAsset>(
          sql`select ${columns} from ${join} where ${cursor ? sql`a.id<${cursor}::uuid` : sql`true`} order by a.id desc limit ${limit + 1}`,
        );
        const has_more = result.rows.length > limit,
          data = result.rows.slice(0, limit).map(assetValue);
        return {
          data,
          has_more,
          next_cursor: has_more ? data.at(-1)!.id : null,
          max_upload_bytes: files.policy.maxBytes,
          max_decoded_resource_bytes: MAX_DECODED_RESOURCE_BYTES,
        };
      },
    );
  } catch (error) {
    failure(error);
  }
}
export async function renameAsset(
  files: FileService,
  headers: Headers,
  requestId: string,
  id: string,
  name: string,
) {
  try {
    return await files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          files.context,
          files.auth,
          headers,
          'lab:full',
          true,
        );
        if (!validText(name, 120, true))
          throw new PublicFailure(
            400,
            'lab.invalid_input',
            'Use a valid asset name',
          );
        name = name.trim();
        const asset = await loadAsset(tx, id);
        await tx
          .update(assets)
          .set({
            name,
            updatedBy: actor.user.id,
            updatedAt: files.context.clock.now(),
          })
          .where(eq(assets.id, asset.id));
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'lab.asset.rename',
          resourceType: 'lab.asset',
          resourceId: asset.id,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return loadAsset(tx, asset.id);
      },
    );
  } catch (error) {
    failure(error);
  }
}
export async function deleteAsset(
  files: FileService,
  headers: Headers,
  requestId: string,
  id: string,
) {
  try {
    await files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          files.context,
          files.auth,
          headers,
          'lab:full',
          true,
        );
        const asset = await loadAsset(tx, id);
        await tx.delete(assets).where(eq(assets.id, asset.id));
        await tx.delete(assetUploads).where(eq(assetUploads.assetId, asset.id));
        await files.release(tx, asset.representation.file_id, {
          ownerType: 'lab.asset_representation',
          ownerId: asset.representation.id,
        });
        await files.dispose(tx, asset.representation.file_id);
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'lab.asset.delete',
          resourceType: 'lab.asset',
          resourceId: asset.id,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
      },
    );
  } catch (error) {
    for (
      let cause: unknown = error;
      cause instanceof Error;
      cause = cause.cause
    )
      if ('code' in cause && cause.code === '23503')
        throw new PublicFailure(
          409,
          'lab.asset_in_use',
          'Asset is still referenced',
        );
    failure(error);
  }
}
