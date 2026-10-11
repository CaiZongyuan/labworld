import type { WorldService } from './use-cases.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import {
  loadEntity,
  representation,
  registerBinding,
  worldId,
} from './entities.ts';
import { catalog } from './catalog.ts';
import { validConfiguration, type LabEntity } from './domain.ts';
async function idle(tx: DbSession, entity: LabEntity) {
  const result = await tx.execute<{ busy: boolean }>(
    sql`select exists(select 1 from lab.session_objects where entity_id=${entity.id}::uuid) or exists(select 1 from lab.program_runs where entity_id=${entity.id}::uuid and status='running') or exists(select 1 from lab.device_tasks where entity_id=${entity.id}::uuid and ended_at is null) as busy`,
  );
  if (result.rows[0].busy)
    throw new PublicFailure(
      409,
      'lab.entity_in_use',
      'Finish active Sessions and Tasks and stop the program before archiving or changing definition',
    );
}
export async function entityLifecycle(
  world: WorldService,
  headers: Headers,
  requestId: string,
  lab: string,
  id: string,
  operation: 'archive' | 'definition' | 'appearance',
  input?: {
    representation_id?: string | null;
    definition_id?: string;
    definition_version?: string;
    configuration?: Record<string, unknown>;
  },
) {
  return world.context.db.transaction(
    { id: requestId, kind: 'request' },
    async (tx) => {
      const actor = await accessIn(
          tx,
          world.context,
          world.policy,
          headers,
          'lab:full',
          true,
        ),
        entity = await loadEntity(tx, lab, id),
        now = world.context.clock.now();
      if (operation === 'archive') {
        if (entity.archived_at) return entity;
        await idle(tx, entity);
        await tx.execute(
          sql`update lab.entities set archived_at=${now}::timestamptz,updated_by=${actor.user.id}::uuid,updated_at=${now}::timestamptz where id=${entity.id}::uuid`,
        );
      } else if (operation === 'appearance') {
        const appearance =
          input?.representation_id === undefined ||
          input.representation_id === null
            ? null
            : worldId(input.representation_id);
        await representation(tx, appearance);
        await tx.execute(
          sql`update lab.entities set representation_id=${appearance}::uuid,updated_by=${actor.user.id}::uuid,updated_at=${now}::timestamptz where id=${entity.id}::uuid`,
        );
        const nodes = await tx.execute<{ id: string }>(
          sql`update lab.scene_nodes set representation_id=${appearance}::uuid where entity_id=${entity.id}::uuid returning id`,
        );
        if (nodes.rows.length)
          await tx.execute(
            sql`update lab.labs set layout_version=layout_version+1 where id=${entity.lab_id}::uuid`,
          );
      } else {
        if (entity.archived_at)
          throw new PublicFailure(
            409,
            'lab.entity_archived',
            'This Entity is archived',
          );
        await idle(tx, entity);
        const definition = catalog.find(
          (entry) =>
            entry.id === input?.definition_id &&
            entry.version === input.definition_version,
        );
        if (!definition)
          throw new PublicFailure(
            400,
            'lab.invalid_reference',
            'Use an existing definition version',
          );
        if (!input?.configuration || !validConfiguration(input.configuration))
          throw new PublicFailure(
            400,
            'lab.invalid_input',
            'Use valid Entity configuration',
          );
        const incompatible = await tx.execute<{ incompatible: boolean }>(
          sql`select exists(select 1 from lab.entity_relationships r join lab.entities other on other.id=case when r.source_id=${entity.id}::uuid then r.target_id else r.source_id end where (r.source_id=${entity.id}::uuid or r.target_id=${entity.id}::uuid) and ((r.kind='simulates' and other.definition_id<>${definition.id}) or ((r.kind='located_in' and r.target_id=${entity.id}::uuid or r.kind='contains' and r.source_id=${entity.id}::uuid) and ${definition.category} not in('furniture','location','labware')))) as incompatible`,
        );
        if (incompatible.rows[0].incompatible)
          throw new PublicFailure(
            400,
            'lab.invalid_reference',
            'Definition conflicts with registered relationships',
          );
        await tx.execute(
          sql`update lab.entities set kind=${definition.category},definition_id=${definition.id},definition_version=${definition.version},definition=${JSON.stringify(definition)}::jsonb,configuration=${JSON.stringify(input.configuration)}::jsonb,updated_by=${actor.user.id}::uuid,updated_at=${now}::timestamptz where id=${entity.id}::uuid`,
        );
        if (entity.binding)
          await tx.execute(
            sql`update lab.runtime_bindings set current=false where entity_id=${entity.id}::uuid and current`,
          );
        await registerBinding(tx, entity.id, definition.id, entity.reality);
      }
      await databaseAudit.record(tx, {
        actorId: actor.user.id,
        actorType: actor.isApiKey ? 'agent' : 'user',
        action: 'lab.entity.' + operation,
        resourceType: 'lab.world',
        resourceId: entity.id,
        requestId,
        correlationId: requestId,
        metadata: {},
      });
      return loadEntity(tx, lab, id);
    },
  );
}
