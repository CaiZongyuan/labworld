import { randomUUID } from 'node:crypto';
import { accessIn, requireAccess } from '../../core/api-keys/authentication.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import type { FileService } from '../../core/files/use-cases.ts';
import type { FileInfo, UploadInput } from '../../core/files/domain.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { canonicalUuid } from '../../platform/uuid.ts';
import { validGlb } from '../assets/validation.ts';
import { catalog } from '../world/catalog.ts';
import type { AssetDefinition } from '../world/domain.ts';
import {
  type AssetDescription,
  type AssetVersion,
  type VersionResource,
} from './domain.ts';
import {
  contentDigest,
  invalidDescription,
  validateDescription,
} from './validation.ts';

const versionColumns = sql`v.id::text,v.asset_id,v.namespace,v.version,v.content_sha256,v.definition,v.representations,v.created_by::text,v.created_at,
  coalesce((select jsonb_agg(jsonb_build_object('key',r.key,'file_id',r.file_id,'format',r.format,'verification',r.verification,'sha256',encode(f.sha256,'hex'),'size',f.actual_size,'file_name',f.file_name,'content_type',f.content_type,'representation_id',r.representation_id) order by r.key) from lab.asset_version_resources r join labos_threejs_core.files f on f.id=r.file_id where r.version_id=v.id),'[]'::jsonb) as resources`;
function value(row: AssetVersion): AssetVersion {
  return { ...row, created_at: utcInstant(row.created_at) };
}
export async function assetVersionIn(tx: DbSession, id: string) {
  const canonical = canonicalUuid(id);
  if (!canonical)
    throw new PublicFailure(
      404,
      'lab.asset_version_not_found',
      'Asset version not found',
    );
  const rows = await tx.execute<AssetVersion>(
    sql`select ${versionColumns} from lab.asset_versions v where v.id=${canonical}::uuid`,
  );
  if (!rows.rows[0])
    throw new PublicFailure(
      404,
      'lab.asset_version_not_found',
      'Asset version not found',
    );
  return value(rows.rows[0]);
}
export function projectDefinition(version: AssetVersion): AssetDefinition {
  const definition = version.definition;
  return {
    id: version.asset_id,
    version: version.version,
    name: definition.name,
    name_en: definition.name_en ?? definition.name,
    category: definition.category,
    specifications: definition.specifications,
    state: definition.state_schema,
    capabilities: definition.capabilities.map((entry) => ({
      ...entry,
      implemented: false,
    })),
    interfaces: [],
    asset_version: version,
  };
}
export async function resolveDefinitionIn(
  tx: DbSession,
  id: string,
  version: string,
): Promise<AssetDefinition | undefined> {
  const builtIn = catalog.find(
    (entry) => entry.id === id && entry.version === version,
  );
  if (builtIn) return builtIn;
  const rows = await tx.execute<{ id: string }>(
    sql`select id::text from lab.asset_versions where asset_id=${id} and version=${version}`,
  );
  return rows.rows[0]
    ? projectDefinition(await assetVersionIn(tx, rows.rows[0].id))
    : undefined;
}
export async function importedDefinitionsIn(tx: DbSession) {
  const rows = await tx.execute<AssetVersion>(
    sql`select ${versionColumns} from lab.asset_versions v order by v.asset_id,v.version`,
  );
  return rows.rows.map((row) => projectDefinition(value(row)));
}
export class AssetRegistry {
  readonly files: FileService;
  constructor(files: FileService) {
    this.files = files;
    files.registerProvisionalReference({
      owner: 'Asset registry resource upload receipt',
      schema: 'lab',
      table: 'asset_resource_uploads',
      column: 'upload_id',
    });
  }
  async startResource(headers: Headers, requestId: string, input: UploadInput) {
    return this.files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.files.context,
          this.files.auth,
          headers,
          'lab:full',
          true,
        );
        const upload = await this.files.start(tx, actor, input);
        await tx.execute(
          sql`insert into lab.asset_resource_uploads(upload_id,created_by) values(${upload.upload_id}::uuid,${actor.user.id}::uuid)`,
        );
        return upload;
      },
    );
  }
  private async resourceUploadIn(tx: DbSession, id: string) {
    const canonical = canonicalUuid(id);
    if (!canonical)
      throw new PublicFailure(
        404,
        'lab.asset_resource_upload_not_found',
        'Resource upload not found',
      );
    const row = await tx.execute<{ upload_id: string }>(
      sql`select upload_id::text from lab.asset_resource_uploads where upload_id=${canonical}::uuid`,
    );
    if (!row.rows[0])
      throw new PublicFailure(
        404,
        'lab.asset_resource_upload_not_found',
        'Resource upload not found',
      );
    return row.rows[0].upload_id;
  }
  async completeResource(
    headers: Headers,
    requestId: string,
    id: string,
  ): Promise<FileInfo> {
    const actor = await requireAccess(
      this.files.context,
      this.files.auth,
      headers,
      requestId,
      'lab:full',
      true,
    );
    await this.files.context.db.read({ id: requestId, kind: 'request' }, (tx) =>
      this.resourceUploadIn(tx, id),
    );
    return this.files.complete(actor, id, requestId, async (tx, file) => {
      await this.resourceUploadIn(tx, id);
      await this.files.pin(tx, file.id, {
        ownerType: 'lab.asset_resource_upload',
        ownerId: id,
      });
      return file;
    });
  }
  async cancelResource(headers: Headers, requestId: string, id: string) {
    return this.files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(
          tx,
          this.files.context,
          this.files.auth,
          headers,
          'lab:full',
          true,
        );
        const upload = await this.resourceUploadIn(tx, id);
        await tx.execute(
          sql`delete from lab.asset_resource_uploads where upload_id=${upload}::uuid`,
        );
        await this.files.release(tx, upload, {
          ownerType: 'lab.asset_resource_upload',
          ownerId: upload,
        });
        try {
          await this.files.dispose(tx, upload);
        } catch (error) {
          if (
            !(error instanceof PublicFailure) ||
            error.code !== 'files.in_use'
          )
            throw error;
        }
      },
    );
  }
  async publish(
    headers: Headers,
    requestId: string,
    description: AssetDescription,
  ) {
    validateDescription(description);
    const actor = await requireAccess(
      this.files.context,
      this.files.auth,
      headers,
      requestId,
      'lab:full',
      true,
    );
    const verified = new Map<string, VersionResource['verification']>();
    for (const resource of description.resources) {
      const file = await this.files.context.db.read(
        { id: requestId, kind: 'request' },
        async (tx) => {
          await accessIn(
            tx,
            this.files.context,
            this.files.auth,
            headers,
            'lab:full',
            true,
          );
          const file = await this.files.load(tx, resource.file_id);
          if (
            file.state !== 'ready' ||
            file.actualSize !== resource.size ||
            file.sha256.toString('hex') !== resource.sha256
          )
            invalidDescription(
              `Resource ${resource.key} is not the declared ready content`,
            );
          return file;
        },
      );
      const media = {
        glb: ['model/gltf-binary'],
        usd: ['model/vnd.usd', 'application/octet-stream'],
        urdf: ['application/xml', 'text/xml'],
        pdf: ['application/pdf'],
        json: ['application/json'],
      }[resource.format];
      if (!media.includes(file.contentType))
        invalidDescription(
          `Resource ${resource.key} media type does not match its format`,
        );
      const chunks: Uint8Array[] = [];
      for await (const chunk of await this.files.managedBytes(
        resource.file_id,
        { id: requestId, kind: 'request' },
        {
          expectedSize: resource.size,
          maximumBytes: Math.max(this.files.policy.maxBytes, resource.size),
        },
      ))
        chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      let verification: VersionResource['verification'] = 'opaque';
      if (resource.format === 'glb') {
        if (!(await validGlb(bytes)))
          invalidDescription(
            `Resource ${resource.key} is not valid self-contained GLB`,
          );
        verification = 'glb-validated';
      } else if (resource.format === 'json') {
        try {
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          invalidDescription(
            `Resource ${resource.key} must contain valid UTF-8 JSON`,
          );
        }
        verification = 'json-parsed';
      } else if (resource.format === 'usd') {
        if (
          !bytes.subarray(0, 8).equals(Buffer.from('PXR-USDC')) &&
          !bytes.subarray(0, 5).equals(Buffer.from('#usda'))
        )
          invalidDescription(
            `Resource ${resource.key} must contain a USD ASCII or crate header`,
          );
        verification = 'usd-header';
      } else if (resource.format === 'pdf') {
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
          invalidDescription(
            `Resource ${resource.key} must contain a PDF header`,
          );
        verification = 'pdf-header';
      }
      verified.set(resource.key, verification);
    }
    return this.files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(
          tx,
          this.files.context,
          this.files.auth,
          headers,
          'lab:full',
          true,
        );
        const digest = contentDigest(description),
          existing = await tx.execute<{ id: string; content_sha256: string }>(
            sql`select id::text,content_sha256 from lab.asset_versions where asset_id=${description.asset_id} and version=${description.version}`,
          );
        if (existing.rows[0]) {
          if (existing.rows[0].content_sha256 !== digest)
            throw new PublicFailure(
              409,
              'lab.asset_version_conflict',
              'Published asset version has different content; publish an explicit new version',
            );
          return assetVersionIn(tx, existing.rows[0].id);
        }
        if (catalog.some((entry) => entry.id === description.asset_id))
          invalidDescription('Built-in definition identities are reserved');
        const id = randomUUID(),
          { resources, representations, ...definition } = description;
        await tx.execute(
          sql`insert into lab.asset_versions(id,asset_id,namespace,version,content_sha256,definition,representations,created_by) values(${id}::uuid,${description.asset_id},${description.asset_id.split('/')[0]},${description.version},${digest},${JSON.stringify(definition)}::jsonb,${JSON.stringify(representations)}::jsonb,${actor.user.id}::uuid)`,
        );
        for (const resource of resources) {
          const file = await this.files.load(tx, resource.file_id);
          if (
            file.state !== 'ready' ||
            file.actualSize !== resource.size ||
            file.sha256.toString('hex') !== resource.sha256
          )
            invalidDescription(
              `Resource ${resource.key} changed before publication`,
            );
          let representationId: string | null = null,
            projectedAssetId: string | null = null;
          if (resource.format === 'glb') {
            const old = await tx.execute<{ id: string }>(
              sql`select id::text from lab.asset_representations where file_id=${file.id}::uuid`,
            );
            representationId = old.rows[0]?.id ?? randomUUID();
            if (!old.rows[0]) {
              projectedAssetId = randomUUID();
              await tx.execute(
                sql`insert into lab.assets(id,name,source,license,version,created_by,updated_by) values(${projectedAssetId}::uuid,${description.name},${description.source},${description.license},${description.version},${actor.user.id}::uuid,${actor.user.id}::uuid)`,
              );
              await tx.execute(
                sql`insert into lab.asset_representations(id,asset_id,file_id,file_name,size,sha256,content_type) values(${representationId}::uuid,${projectedAssetId}::uuid,${file.id}::uuid,${file.fileName},${file.actualSize},${resource.sha256},${file.contentType})`,
              );
              await this.files.pin(tx, file.id, {
                ownerType: 'lab.asset_representation',
                ownerId: representationId,
              });
            }
          }
          await tx.execute(
            sql`insert into lab.asset_version_resources(version_id,key,file_id,format,verification,representation_id,projected_asset_id) values(${id}::uuid,${resource.key},${file.id}::uuid,${resource.format},${verified.get(resource.key)!},${representationId}::uuid,${projectedAssetId}::uuid)`,
          );
          await this.files.pin(tx, file.id, {
            ownerType: 'lab.asset_version',
            ownerId: id,
          });
          await this.files.release(tx, file.id, {
            ownerType: 'lab.asset_resource_upload',
            ownerId: file.id,
          });
        }
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'lab.asset_version.publish',
          resourceType: 'lab.asset_version',
          resourceId: id,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return assetVersionIn(tx, id);
      },
    );
  }
  async get(headers: Headers, requestId: string, id: string) {
    return this.files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(
          tx,
          this.files.context,
          this.files.auth,
          headers,
          'lab:full',
        );
        return assetVersionIn(tx, id);
      },
    );
  }
  async list(
    headers: Headers,
    requestId: string,
    query: {
      asset_id?: string;
      version?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    const limit = query.limit ?? 50;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (query.cursor !== undefined && !canonicalUuid(query.cursor))
    )
      throw new PublicFailure(
        400,
        'lab.invalid_input',
        'Use valid asset-version pagination',
      );
    return this.files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(
          tx,
          this.files.context,
          this.files.auth,
          headers,
          'lab:full',
        );
        const rows = await tx.execute<AssetVersion>(
          sql`select ${versionColumns} from lab.asset_versions v where ${query.asset_id === undefined ? sql`true` : sql`v.asset_id=${query.asset_id}`} and ${query.version === undefined ? sql`true` : sql`v.version=${query.version}`} and ${query.cursor === undefined ? sql`true` : sql`v.id<${query.cursor}::uuid`} order by v.id desc limit ${limit + 1}`,
        );
        const has_more = rows.rows.length > limit,
          data = rows.rows.slice(0, limit).map(value);
        return {
          data,
          has_more,
          next_cursor: has_more ? data.at(-1)!.id : null,
        };
      },
    );
  }
  async download(
    headers: Headers,
    requestId: string,
    id: string,
    resourceKey: string,
  ) {
    return this.files.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.files.context,
          this.files.auth,
          headers,
          'lab:full',
        );
        const version = await assetVersionIn(tx, id),
          resource = version.resources.find(
            (entry) => entry.key === resourceKey,
          );
        if (!resource)
          throw new PublicFailure(
            404,
            'lab.asset_version_not_found',
            'Asset version resource not found',
          );
        return this.files.download(tx, actor, resource.file_id);
      },
    );
  }
}
