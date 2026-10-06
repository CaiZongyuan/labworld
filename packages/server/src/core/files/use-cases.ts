import {
  randomUUID,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { canonicalUuid } from '../../platform/uuid.ts';
import {
  LocalBlobStore,
  BlobMissing,
  BlobChanged,
  BlobTooLarge,
  BlobChecksumMismatch,
} from '../../platform/blob-store.ts';
import type { AuthPolicy } from '../identity/domain.ts';
import { revalidateIn, type AccessActor } from '../api-keys/authentication.ts';
import { databaseAudit } from '../audit/use-cases.ts';
import { files, fileCandidates, fileReferences } from './schema.ts';
import {
  normalizeUpload,
  validContents,
  type FilePolicy,
  type UploadInput,
  type UploadCapability,
  type FileInfo,
  type ObjectCapability,
  type DownloadCapability,
} from './domain.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
type FileRow = typeof files.$inferSelect;
export type FileReference = { ownerType: string; ownerId: string };
const failure = (
  status: PublicFailure['status'],
  code: string,
  message: string,
) => new PublicFailure(status, `files.${code}`, message);
const unavailable = () =>
  failure(503, 'unavailable', 'File storage is temporarily unavailable');
function storageFailure(error: unknown): never {
  if (error instanceof PublicFailure) throw error;
  if (error instanceof BlobMissing)
    throw failure(
      409,
      'upload_missing',
      'Upload the file bytes before completing',
    );
  if (error instanceof BlobChanged)
    throw failure(
      409,
      'upload_changed',
      'Staging content changed; retry completion',
    );
  if (error instanceof BlobTooLarge)
    throw failure(413, 'too_large', 'File exceeds the allowed size');
  if (error instanceof BlobChecksumMismatch)
    throw failure(400, 'invalid_input', 'Upload checksum does not match');
  throw unavailable();
}
function info(row: FileRow): FileInfo {
  return {
    id: row.id,
    file_name: row.fileName,
    content_type: row.contentType,
    size: row.actualSize!,
    sha256: row.sha256.toString('hex'),
    created_at: utcInstant(row.createdAt),
    previewable: [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ].includes(row.contentType),
  };
}
export class FileService {
  context: FoundationContext;
  policy: FilePolicy;
  auth: AuthPolicy;
  origin: string;
  directory: string;
  blobs: LocalBlobStore;
  private signingKey?: Buffer;
  constructor(
    context: FoundationContext,
    policy: FilePolicy,
    auth: AuthPolicy,
    origin: string,
    directory: string,
  ) {
    this.context = context;
    this.policy = policy;
    this.auth = auth;
    this.origin = origin;
    this.directory = directory;
    this.blobs = new LocalBlobStore(join(directory, 'blobs'));
  }
  async initialize() {
    await this.blobs.initialize();
    const secrets = join(this.directory, 'secrets');
    await mkdir(secrets, { recursive: true, mode: 0o700 });
    const path = join(secrets, 'file-signing-key');
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(randomBytes(32));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    }
    this.signingKey = await readFile(path);
    if (this.signingKey.length !== 32)
      throw new Error('File signing key is invalid');
  }
  private signature(method: string, id: string, expires: string) {
    if (!this.signingKey) throw unavailable();
    return createHmac('sha256', this.signingKey)
      .update(`${method}\n${id}\n${expires}`)
      .digest();
  }
  private capability(row: FileRow, method: 'GET' | 'PUT'): ObjectCapability {
    const expires = String(
      method === 'PUT'
        ? Date.parse(row.expiresAt)
        : Date.parse(this.context.clock.now()) +
            this.policy.downloadSecs * 1000,
    );
    return {
      url: `${this.origin}/objects/${row.id}?expires=${expires}&signature=${this.signature(method, row.id, expires).toString('hex')}`,
      method,
      headers: method === 'PUT' ? { 'content-type': row.contentType } : {},
      expires_at: new Date(Number(expires)).toISOString(),
    };
  }
  private checkCapability(
    id: string,
    method: 'PUT' | 'GET',
    query: URLSearchParams,
  ) {
    const expires = query.get('expires'),
      signature = query.get('signature');
    if (
      !canonicalUuid(id) ||
      !expires ||
      !/^\d{13}$/.test(expires) ||
      !signature ||
      !/^[0-9a-f]{64}$/.test(signature) ||
      query.getAll('expires').length !== 1 ||
      query.getAll('signature').length !== 1 ||
      !timingSafeEqual(
        Buffer.from(signature, 'hex'),
        this.signature(method, id, expires),
      )
    )
      throw failure(403, 'invalid_signature', 'File capability is invalid');
    if (Number(expires) <= Date.parse(this.context.clock.now()))
      throw failure(
        410,
        'upload_expired',
        'File capability expired; request a new URL',
      );
  }
  async load(tx: DbSession, id: string) {
    const canonical = canonicalUuid(id);
    if (!canonical) throw failure(404, 'not_found', 'File not found');
    const [row] = await tx.select().from(files).where(eq(files.id, canonical));
    if (!row) throw failure(404, 'not_found', 'File not found');
    return row;
  }
  private async read(id: string, requestId: string) {
    try {
      return await this.context.db.read(
        { id: requestId, kind: 'request' },
        (tx) => this.load(tx, id),
      );
    } catch (error) {
      storageFailure(error);
    }
  }
  async start(
    tx: DbSession,
    actor: AccessActor,
    input: UploadInput,
  ): Promise<UploadCapability> {
    await revalidateIn(
      tx,
      this.context,
      this.auth,
      actor,
      actor.authorizedScope,
    );
    const normalized = normalizeUpload(input, this.policy);
    if (normalized === 'too_large')
      throw failure(413, 'too_large', 'File exceeds the allowed size');
    if (!normalized)
      throw failure(
        400,
        'invalid_input',
        'Use a valid filename, media type, size and SHA-256',
      );
    const id = randomUUID(),
      expiresAt = new Date(
        Date.parse(this.context.clock.now()) + this.policy.uploadSecs * 1000,
      ).toISOString();
    const [row] = await tx
      .insert(files)
      .values({
        id,
        createdBy: actor.user.id,
        fileName: normalized.file_name,
        contentType: normalized.content_type,
        declaredSize: normalized.size,
        sha256: Buffer.from(normalized.sha256, 'hex'),
        stagingKey: `staging/${id}`,
        expiresAt,
      })
      .returning();
    return {
      upload_id: id,
      state: row.state,
      upload: this.capability(row, 'PUT'),
    };
  }
  private pending(row: FileRow) {
    if (row.state === 'rejected')
      throw failure(
        422,
        'upload_rejected',
        'Upload was rejected; start a new upload',
      );
    if (row.state !== 'pending_upload')
      throw failure(404, 'not_found', 'Upload is unavailable');
    if (Date.parse(row.expiresAt) <= Date.parse(this.context.clock.now()))
      throw failure(
        410,
        'upload_expired',
        'Upload expired; start a new upload',
      );
  }
  async upload(
    id: string,
    query: URLSearchParams,
    contentType: string,
    bytes: AsyncIterable<Uint8Array>,
    requestId: string,
  ) {
    this.checkCapability(id, 'PUT', query);
    const row = await this.read(id, requestId);
    this.pending(row);
    if (contentType !== row.contentType)
      throw failure(
        400,
        'invalid_input',
        'Use the content type in the upload capability',
      );
    try {
      await this.blobs.stageAt(
        row.stagingKey,
        bytes,
        this.policy.maxBytes,
        row.sha256.toString('hex'),
      );
    } catch (error) {
      storageFailure(error);
    }
  }
  async complete<T>(
    actor: AccessActor,
    id: string,
    requestId: string,
    publish: (
      tx: DbSession,
      file: FileInfo,
      transitioned: boolean,
    ) => Promise<T>,
  ): Promise<T> {
    const planned = await this.read(id, requestId);
    const hash = planned.sha256.toString('hex');
    return this.blobs.withHash(hash, async () => {
      let key: string;
      try {
        if (planned.state === 'ready') {
          key = planned.readyKey!;
          const digest = await this.blobs.inspect(key, this.policy.maxBytes);
          if (digest.sha256 !== hash || digest.size !== planned.actualSize)
            throw new BlobChanged('Ready content changed');
        } else {
          this.pending(planned);
          const digest = await this.blobs.inspect(
            planned.stagingKey,
            this.policy.maxBytes,
          );
          if (
            digest.sha256 !== hash ||
            digest.size !== planned.declaredSize ||
            !validContents(planned.contentType, digest.prefix)
          ) {
            await this.context.db.transaction(
              { id: requestId, kind: 'request' },
              async (tx) => {
                await revalidateIn(
                  tx,
                  this.context,
                  this.auth,
                  actor,
                  actor.authorizedScope,
                );
                await tx
                  .update(files)
                  .set({
                    state: 'rejected',
                    lastError: 'files.upload_rejected',
                    updatedAt: this.context.clock.now(),
                  })
                  .where(
                    and(
                      eq(files.id, planned.id),
                      eq(files.state, 'pending_upload'),
                    ),
                  );
              },
            );
            throw failure(
              422,
              'upload_rejected',
              'Upload was rejected; start a new upload',
            );
          }
          key = await this.blobs.adopt(planned.stagingKey, hash);
        }
        return await this.context.db.transaction(
          { id: requestId, kind: 'request' },
          async (tx) => {
            const currentActor = await revalidateIn(
              tx,
              this.context,
              this.auth,
              actor,
              actor.authorizedScope,
            );
            let row = await this.load(tx, planned.id);
            const transitioned = row.state !== 'ready';
            if (transitioned) {
              this.pending(row);
              const candidateId = randomUUID();
              await tx.insert(fileCandidates).values({
                id: candidateId,
                fileId: row.id,
                objectKey: `candidates/${candidateId}`,
                state: 'adopted',
              });
              [row] = await tx
                .update(files)
                .set({
                  state: 'ready',
                  readyKey: key,
                  readyCandidateId: candidateId,
                  actualSize: row.declaredSize,
                  updatedAt: this.context.clock.now(),
                })
                .where(eq(files.id, row.id))
                .returning();
            }
            const result = await publish(tx, info(row), transitioned);
            if (transitioned)
              await databaseAudit.record(tx, {
                actorId: currentActor.user.id,
                actorType: currentActor.isApiKey ? 'agent' : 'user',
                action: 'files.complete',
                resourceType: 'files.file',
                resourceId: row.id,
                requestId,
                correlationId: requestId,
                metadata: {},
              });
            return result;
          },
        );
      } catch (error) {
        storageFailure(error);
      }
    });
  }
  async pin(tx: DbSession, id: string, reference: FileReference) {
    if (
      !reference.ownerType ||
      !reference.ownerId ||
      reference.ownerType.length > 200 ||
      reference.ownerId.length > 200
    )
      throw failure(400, 'invalid_input', 'Use a valid logical file reference');
    const row = await this.load(tx, id);
    if (row.state !== 'ready')
      throw failure(404, 'not_found', 'Ready file not found');
    await tx
      .insert(fileReferences)
      .values({ fileId: row.id, ...reference })
      .onConflictDoNothing();
  }
  async release(tx: DbSession, id: string, reference: FileReference) {
    await tx
      .delete(fileReferences)
      .where(
        and(
          eq(fileReferences.fileId, id),
          eq(fileReferences.ownerType, reference.ownerType),
          eq(fileReferences.ownerId, reference.ownerId),
        ),
      );
  }
  async dispose(tx: DbSession, id: string) {
    const row = await this.load(tx, id);
    if ((await this.referencesIn(tx, row.id)).length)
      throw failure(409, 'in_use', 'File is still referenced');
    await tx
      .update(files)
      .set({ state: 'deleting' })
      .where(eq(files.id, row.id));
  }
  // Inspect actual foreign-key consumers generically; Core never imports Lab ownership.
  private async referencesIn(tx: DbSession, id: string): Promise<string[]> {
    const refs = await tx
      .select()
      .from(fileReferences)
      .where(eq(fileReferences.fileId, id));
    const retained = refs.map(
      (reference) => `${reference.ownerType}:${reference.ownerId}`,
    );
    const consumers = await tx.execute<{
      schema_name: string;
      table_name: string;
      column_name: string;
    }>(
      sql`select distinct n.nspname as schema_name,t.relname as table_name,a.attname as column_name from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace cross join lateral generate_subscripts(c.conkey,1) g(i) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[g.i] join pg_attribute b on b.attrelid=c.confrelid and b.attnum=c.confkey[g.i] where c.contype='f' and c.confrelid='labos_threejs_core.files'::regclass and b.attname='id'`,
    );
    const owned = new Set([
      'file_references',
      'file_candidates',
      'object_cleanup',
    ]);
    for (const consumer of consumers.rows) {
      if (
        consumer.schema_name === 'labos_threejs_core' &&
        owned.has(consumer.table_name)
      )
        continue;
      const result = await tx.execute<{ present: boolean }>(
        sql`select exists(select 1 from ${sql.identifier(consumer.schema_name)}.${sql.identifier(consumer.table_name)} where ${sql.identifier(consumer.column_name)}=${id}::uuid) as present`,
      );
      if (result.rows[0].present)
        retained.push(
          `foreign-key:${consumer.schema_name}.${consumer.table_name}`,
        );
    }
    return retained;
  }
  async cleanup(
    requestId: string,
  ): Promise<{ deleted: string[]; retained: string[] }> {
    const targets = await this.context.db.read(
      { id: requestId, kind: 'background' },
      (tx) =>
        tx
          .select()
          .from(files)
          .where(
            sql`${files.state} in ('expired','rejected','deleting') or (${files.state} in ('pending_upload','ready') and ${files.expiresAt}<=${this.context.clock.now()}::timestamptz)`,
          )
          .limit(50),
    );
    const deleted: string[] = [],
      retained: string[] = [];
    for (const target of targets) {
      const hash = target.sha256.toString('hex');
      await this.blobs.withHash(hash, async () => {
        const plan = await this.context.db.transaction(
          { id: requestId, kind: 'background' },
          async (tx) => {
            const row = await this.load(tx, target.id);
            if ((await this.referencesIn(tx, row.id)).length) {
              retained.push(row.id);
              return undefined;
            }
            if (
              ['pending_upload', 'ready'].includes(row.state) &&
              Date.parse(row.expiresAt) > Date.parse(this.context.clock.now())
            )
              return undefined;
            await tx
              .update(files)
              .set({ state: 'deleting', updatedAt: this.context.clock.now() })
              .where(eq(files.id, row.id));
            const live = await tx.execute<{ present: boolean }>(
              sql`select exists(select 1 from labos_threejs_core.files f where f.sha256=${row.sha256} and (f.state='ready' or (f.state='pending_upload' and f.expires_at>${this.context.clock.now()}::timestamptz))) or exists(select 1 from labos_threejs_core.file_candidates c join labos_threejs_core.files f on f.id=c.file_id where f.sha256=${row.sha256} and c.state in ('copying','adopted') and f.state in ('pending_upload','ready')) as present`,
            );
            return {
              stagingKey: row.stagingKey,
              removePhysical: !live.rows[0].present,
            };
          },
        );
        if (!plan) return;
        try {
          await this.blobs.remove(plan.stagingKey);
          if (plan.removePhysical)
            await this.blobs.remove(`objects/${hash.slice(0, 2)}/${hash}`);
        } catch (error) {
          await this.context.db.transaction(
            { id: requestId, kind: 'background' },
            async (tx) => {
              await tx
                .update(files)
                .set({
                  lastError: 'files.cleanup_unavailable',
                  updatedAt: this.context.clock.now(),
                })
                .where(eq(files.id, target.id));
            },
          );
          storageFailure(error);
        }
        await this.context.db.transaction(
          { id: requestId, kind: 'background' },
          async (tx) => {
            await tx
              .update(files)
              .set({
                state: 'deleted',
                lastError: null,
                updatedAt: this.context.clock.now(),
              })
              .where(eq(files.id, target.id));
            await tx
              .update(fileCandidates)
              .set({ state: 'deleted', updatedAt: this.context.clock.now() })
              .where(eq(fileCandidates.fileId, target.id));
          },
        );
        deleted.push(target.id);
      });
    }
    return { deleted, retained };
  }
  async download(
    tx: DbSession,
    actor: AccessActor,
    id: string,
  ): Promise<DownloadCapability> {
    await revalidateIn(
      tx,
      this.context,
      this.auth,
      actor,
      actor.authorizedScope,
    );
    const row = await this.load(tx, id);
    if (row.state !== 'ready')
      throw failure(404, 'not_found', 'Ready file not found');
    return { ...this.capability(row, 'GET'), file: info(row) };
  }
  async signedDownload(id: string, query: URLSearchParams, requestId: string) {
    this.checkCapability(id, 'GET', query);
    const row = await this.read(id, requestId);
    if (row.state !== 'ready')
      throw failure(404, 'not_found', 'Ready file not found');
    try {
      const digest = await this.blobs.inspect(
        row.readyKey!,
        this.policy.maxBytes,
      );
      if (
        digest.sha256 !== row.sha256.toString('hex') ||
        digest.size !== row.actualSize
      )
        throw new BlobChanged('Ready content changed');
    } catch (error) {
      storageFailure(error);
    }
    return {
      contentType: row.contentType,
      size: row.actualSize!,
      bytes: this.blobs.read(row.readyKey!),
    };
  }
}
