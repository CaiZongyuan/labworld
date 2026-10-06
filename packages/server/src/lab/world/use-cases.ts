import { randomUUID } from 'node:crypto';
import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { canonicalUuid } from '../../platform/uuid.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { AuthPolicy } from '../../core/identity/domain.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import {
  validName,
  validConfiguration,
  validPlacement,
  placementAt,
  type PersistentLab,
  type RegisterEntity,
  type LabEntity,
  type CreateSceneNode,
  type CopyLabEntity,
} from './domain.ts';
import { catalog } from './catalog.ts';
import {
  entityColumns,
  entityValue,
  loadEntity,
  representation,
  registerBinding,
  insertNode,
  worldId,
} from './entities.ts';
import { assetValue } from '../assets/use-cases.ts';
import type { LabAsset } from '../assets/domain.ts';
const columns = sql`id::text,name,layout_version,created_by::text,created_at`;
function value(row: PersistentLab) {
  return {
    ...row,
    layout_version: Number(row.layout_version),
    created_at: utcInstant(row.created_at),
  };
}
export async function loadLab(tx: DbSession, id: string) {
  const canonical = canonicalUuid(id);
  if (!canonical)
    throw new PublicFailure(
      400,
      'lab.invalid_reference',
      'Use an existing Lab',
    );
  const rows = await tx.execute<PersistentLab>(
    sql`select ${columns} from lab.labs where id=${canonical}::uuid`,
  );
  if (!rows.rows[0])
    throw new PublicFailure(404, 'lab.world_not_found', 'Lab not found');
  return value(rows.rows[0]);
}
function failure(error: unknown): never {
  if (error instanceof PublicFailure) throw error;
  throw new PublicFailure(
    503,
    'lab.unavailable',
    'Lab is temporarily unavailable',
  );
}
export class WorldService {
  context: FoundationContext;
  policy: AuthPolicy;
  constructor(context: FoundationContext, policy: AuthPolicy) {
    this.context = context;
    this.policy = policy;
  }
  async createNode(
    headers: Headers,
    requestId: string,
    labId: string,
    input: CreateSceneNode,
  ) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          const actor = await accessIn(
              tx,
              this.context,
              this.policy,
              headers,
              'lab:full',
              true,
            ),
            lab = worldId(labId),
            entity = worldId(input.entity_id);
          if (!validPlacement(input.placement))
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Use finite Placement values in the allowed range',
            );
          await loadLab(tx, lab);
          try {
            await loadEntity(tx, lab, entity);
          } catch (error) {
            if (
              error instanceof PublicFailure &&
              error.code === 'lab.world_not_found'
            )
              throw new PublicFailure(
                400,
                'lab.invalid_reference',
                'Use an Entity in this Lab',
              );
            throw error;
          }
          await representation(tx, input.representation_id);
          const count = await tx.execute<{ count: number }>(
            sql`select count(*) as count from lab.scene_nodes where lab_id=${lab}::uuid`,
          );
          if (Number(count.rows[0].count) >= 1000)
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Scene Node capacity reached',
            );
          const node = await insertNode(
            tx,
            lab,
            entity,
            input.representation_id,
            input.placement,
          );
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: actor.isApiKey ? 'agent' : 'user',
            action: 'lab.node.create',
            resourceType: 'lab.world',
            resourceId: node.id,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
          return node;
        },
      );
    } catch (error) {
      failure(error);
    }
  }
  async copy(
    headers: Headers,
    requestId: string,
    labId: string,
    entityId: string,
    input: CopyLabEntity,
  ) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          const actor = await accessIn(
              tx,
              this.context,
              this.policy,
              headers,
              'lab:full',
              true,
            ),
            lab = worldId(labId),
            entity = worldId(entityId);
          if (
            !validName(input.name) ||
            !validPlacement(input.placement) ||
            !Number.isInteger(input.expected_version) ||
            input.expected_version < 0
          )
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Use valid copy metadata and Placement',
            );
          const current = await loadLab(tx, lab);
          if (current.layout_version !== input.expected_version)
            throw new PublicFailure(
              409,
              'lab.layout_conflict',
              'Layout changed; keep the draft, reload the current version and retry',
            );
          const source = await loadEntity(tx, lab, entity),
            count = await tx.execute<{ entities: number; nodes: number }>(
              sql`select (select count(*) from lab.entities where lab_id=${lab}::uuid) as entities,(select count(*) from lab.scene_nodes where lab_id=${lab}::uuid) as nodes`,
            );
          if (
            Number(count.rows[0].entities) >= 1000 ||
            Number(count.rows[0].nodes) >= 1000
          )
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Lab Entity or Scene Node capacity reached',
            );
          const id = randomUUID();
          await tx.execute(
            sql`insert into lab.entities(id,lab_id,name,kind,reality,definition_id,definition_version,definition,configuration,representation_id,created_by,updated_by) values(${id}::uuid,${lab}::uuid,${input.name.trim()},${source.kind},${source.reality},${source.definition_id},${source.definition_version},${JSON.stringify(source.definition)}::jsonb,${JSON.stringify(source.configuration)}::jsonb,${source.representation_id}::uuid,${actor.user.id}::uuid,${actor.user.id}::uuid)`,
          );
          await registerBinding(tx, id, source.definition_id, source.reality);
          await insertNode(
            tx,
            lab,
            id,
            source.representation_id,
            input.placement,
          );
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: actor.isApiKey ? 'agent' : 'user',
            action: 'lab.entity.copy',
            resourceType: 'lab.world',
            resourceId: id,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
          return loadEntity(tx, lab, id);
        },
      );
    } catch (error) {
      failure(error);
    }
  }
  async create(headers: Headers, requestId: string, name: string) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          const actor = await accessIn(
            tx,
            this.context,
            this.policy,
            headers,
            'lab:full',
            true,
          );
          if (!validName(name))
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Use a valid Lab name',
            );
          const id = randomUUID();
          await tx.execute(
            sql`insert into lab.labs(id,name,created_by) values(${id}::uuid,${name.trim()},${actor.user.id}::uuid)`,
          );
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: actor.isApiKey ? 'agent' : 'user',
            action: 'lab.create',
            resourceType: 'lab.world',
            resourceId: id,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
          return loadLab(tx, id);
        },
      );
    } catch (error) {
      failure(error);
    }
  }
  async list(
    headers: Headers,
    requestId: string,
    query: { limit?: number; cursor?: string },
  ) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          await accessIn(tx, this.context, this.policy, headers, 'lab:full');
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
              'Use valid Lab pagination',
            );
          const rows = await tx.execute<PersistentLab>(
            sql`select ${columns} from lab.labs where ${cursor ? sql`id<${cursor}::uuid` : sql`true`} order by id desc limit ${limit + 1}`,
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
    } catch (error) {
      failure(error);
    }
  }
  async world(headers: Headers, requestId: string, id: string) {
    try {
      return await this.context.db.operation(
        { id: requestId, kind: 'request', budget: 10 },
        () =>
          this.context.db.transaction(
            { id: requestId, kind: 'request' },
            async (tx) => {
              await accessIn(
                tx,
                this.context,
                this.policy,
                headers,
                'lab:full',
              );
              const lab = await loadLab(tx, id);
              const result = await tx.execute<{
                version: string;
                entities: LabEntity[];
                nodes: Record<string, unknown>[];
                assets: LabAsset[];
                relationships: Record<string, unknown>[];
              }>(sql`select c.version::text,
        coalesce((select jsonb_agg(to_jsonb(x) order by x.id) from(select ${entityColumns} from lab.entities e where e.lab_id=${lab.id}::uuid) x),'[]'::jsonb) as entities,
        coalesce((select jsonb_agg(to_jsonb(n) order by n.id) from lab.scene_nodes n where n.lab_id=${lab.id}::uuid),'[]'::jsonb) as nodes,
        coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('representation',to_jsonb(r)-'asset_id') order by a.id) from lab.assets a join lab.asset_representations r on r.asset_id=a.id where r.id in(select representation_id from lab.entities where lab_id=${lab.id}::uuid union select representation_id from lab.scene_nodes where lab_id=${lab.id}::uuid)),'[]'::jsonb) as assets,
        coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from lab.entity_relationships r where r.lab_id=${lab.id}::uuid),'[]'::jsonb) as relationships
        from lab.world_clock c where c.singleton`);
              const snapshot = result.rows[0];
              if (!snapshot) throw new Error('World clock unavailable');
              return {
                ...snapshot,
                lab,
                entities: snapshot.entities.map(entityValue),
                assets: snapshot.assets.map(assetValue),
              };
            },
          ),
      );
    } catch (error) {
      failure(error);
    }
  }

  async definitions(
    headers: Headers,
    requestId: string,
    id?: string,
    version?: string,
  ) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          await accessIn(tx, this.context, this.policy, headers, 'lab:full');
          if (id === undefined) return { data: catalog };
          const definition = catalog.find(
            (entry) => entry.id === id && entry.version === version,
          );
          if (!definition)
            throw new PublicFailure(
              404,
              'lab.asset_not_found',
              'Definition not found',
            );
          return definition;
        },
      );
    } catch (error) {
      failure(error);
    }
  }
  async register(
    headers: Headers,
    requestId: string,
    labId: string,
    input: RegisterEntity,
  ) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          const actor = await accessIn(
              tx,
              this.context,
              this.policy,
              headers,
              'lab:full',
              true,
            ),
            lab = worldId(labId);
          if (
            !validName(input.name) ||
            !validConfiguration(input.configuration)
          )
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Use valid Entity metadata',
            );
          const definition = catalog.find(
            (entry) =>
              entry.id === input.definition_id &&
              entry.version === input.definition_version,
          );
          if (!definition)
            throw new PublicFailure(
              400,
              'lab.invalid_reference',
              'Use an existing definition version',
            );
          await loadLab(tx, lab);
          const count = await tx.execute<{ entities: number; nodes: number }>(
            sql`select (select count(*) from lab.entities where lab_id=${lab}::uuid) as entities,(select count(*) from lab.scene_nodes where lab_id=${lab}::uuid) as nodes`,
          );
          if (
            Number(count.rows[0].entities) >= 1000 ||
            Number(count.rows[0].nodes) >= 1000
          )
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Lab Entity or Scene Node capacity reached',
            );
          await representation(tx, input.representation_id);
          const id = randomUUID();
          await tx.execute(
            sql`insert into lab.entities(id,lab_id,name,kind,reality,definition_id,definition_version,definition,configuration,representation_id,created_by,updated_by) values(${id}::uuid,${lab}::uuid,${input.name.trim()},${definition.category},${input.reality},${definition.id},${definition.version},${JSON.stringify(definition)}::jsonb,${JSON.stringify(input.configuration)}::jsonb,${input.representation_id ?? null}::uuid,${actor.user.id}::uuid,${actor.user.id}::uuid)`,
          );
          await registerBinding(tx, id, definition.id, input.reality);
          await insertNode(
            tx,
            lab,
            id,
            input.representation_id,
            placementAt(Number(count.rows[0].entities)),
          );
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: actor.isApiKey ? 'agent' : 'user',
            action: 'lab.entity.register',
            resourceType: 'lab.world',
            resourceId: id,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
          return loadEntity(tx, lab, id);
        },
      );
    } catch (error) {
      failure(error);
    }
  }
  async entity(headers: Headers, requestId: string, lab: string, id: string) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          await accessIn(tx, this.context, this.policy, headers, 'lab:full');
          return loadEntity(tx, lab, id);
        },
      );
    } catch (error) {
      failure(error);
    }
  }
  async configure(
    headers: Headers,
    requestId: string,
    labId: string,
    id: string,
    input: { name: string; configuration: Record<string, unknown> },
  ) {
    try {
      return await this.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          const actor = await accessIn(
              tx,
              this.context,
              this.policy,
              headers,
              'lab:full',
              true,
            ),
            lab = worldId(labId),
            entity = worldId(id);
          if (
            !validName(input.name) ||
            !validConfiguration(input.configuration)
          )
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Use valid Entity configuration',
            );
          const updated = await tx.execute(
            sql`update lab.entities set name=${input.name.trim()},configuration=${JSON.stringify(input.configuration)}::jsonb,updated_by=${actor.user.id}::uuid,updated_at=${this.context.clock.now()}::timestamptz where lab_id=${lab}::uuid and id=${entity}::uuid returning id`,
          );
          if (!updated.rows.length)
            throw new PublicFailure(
              404,
              'lab.world_not_found',
              'Lab or Entity not found',
            );
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: actor.isApiKey ? 'agent' : 'user',
            action: 'lab.entity.configure',
            resourceType: 'lab.world',
            resourceId: entity,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
          return loadEntity(tx, lab, entity);
        },
      );
    } catch (error) {
      failure(error);
    }
  }
}
