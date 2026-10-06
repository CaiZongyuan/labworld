import { randomUUID } from 'node:crypto';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { canonicalUuid } from '../../platform/uuid.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { catalog } from './catalog.ts';
import type { LabEntity, Placement, SceneNode } from './domain.ts';
export const entityColumns = sql`e.id::text,e.lab_id::text,e.name,e.kind,e.reality,e.definition_id,e.definition_version,e.definition,e.configuration,e.representation_id::text,e.created_by::text,e.updated_by::text,e.created_at,e.updated_at,e.archived_at,
  (select to_jsonb(b)-'current' from lab.runtime_bindings b where b.entity_id=e.id and b.current) as binding,
  (select (to_jsonb(r)-'generation'-'sequence'-'last_observed_at'-'next_sample_at')||jsonb_build_object('program_id',b.program_id,'source',b.source,'definition_id',b.definition_id,'definition_version',b.definition_version,'definition',b.definition) from lab.program_runs r join lab.runtime_bindings b on b.id=r.binding_id where r.entity_id=e.id order by r.started_at desc,r.id desc limit 1) as program_run,
  (select (to_jsonb(o)-'observed_times')||jsonb_build_object('freshness',case when o.freshness='stale' then 'stale' when r.status<>'running' then r.status else o.freshness end) from lab.current_observations o join lab.program_runs r on r.id=o.run_id where o.entity_id=e.id) as observation,
  (select to_jsonb(t)-'last_tick_at'-'pending_outcome' from lab.device_tasks t where t.entity_id=e.id order by t.created_at desc,t.id desc limit 1) as task,
  (select to_jsonb(r) from lab.device_task_results r join lab.device_tasks t on t.result_id=r.id where t.entity_id=e.id order by t.created_at desc,t.id desc limit 1) as task_result`;
function times(row: Record<string, unknown> | null, fields: string[]) {
  if (!row) return row;
  const value = { ...row };
  for (const field of fields)
    if (typeof value[field] === 'string')
      value[field] = utcInstant(value[field] as string);
  return value;
}
export function entityValue(row: LabEntity): LabEntity {
  const implementation =
    row.binding &&
    ['light.v1', 'centrifuge.v1'].includes(row.binding.program_id)
      ? (catalog.find(
          (definition) =>
            definition.id === row.definition_id && definition.version === '1.0',
        )?.capabilities ?? [])
      : [];
  const running = row.program_run?.status === 'running',
    busy =
      row.task &&
      ['pending', 'preparing', 'running', 'decelerating'].includes(
        String(row.task.status),
      );
  const capabilities = row.definition.capabilities.map((capability) => {
    const implemented = implementation.find(
        (entry) => entry.id === capability.id,
      ),
      contract = implemented ?? capability;
    const isBusy = capability.id === 'centrifuge.start' && busy;
    return {
      id: capability.id,
      version: contract.version,
      definition_supported: true,
      binding_implemented: !!implemented,
      executable: !row.archived_at && !!implemented && running && !isBusy,
      reason: row.archived_at
        ? 'entity_archived'
        : !implemented
          ? 'binding_not_implemented'
          : isBusy
            ? 'device_busy'
            : running
              ? 'ready'
              : 'program_not_running',
      parameters: contract.parameters,
      result: contract.result,
    };
  });
  return {
    ...row,
    created_at: utcInstant(row.created_at),
    updated_at: utcInstant(row.updated_at),
    archived_at: row.archived_at ? utcInstant(row.archived_at) : null,
    program_run: times(row.program_run, ['started_at', 'ended_at']),
    observation: times(row.observation, [
      'observed_at',
      'received_at',
      'updated_at',
    ]),
    task: times(row.task, ['created_at', 'ended_at', 'timer_started_at']),
    task_result: times(row.task_result, ['ended_at']),
    capabilities,
  };
}
export function worldId(id: string) {
  const canonical = canonicalUuid(id);
  if (!canonical)
    throw new PublicFailure(
      400,
      'lab.invalid_reference',
      'Use an existing Lab, Entity and representation',
    );
  return canonical;
}
export async function loadEntity(tx: DbSession, lab: string, id: string) {
  const rows = await tx.execute<LabEntity>(
    sql`select ${entityColumns} from lab.entities e where e.lab_id=${worldId(lab)}::uuid and e.id=${worldId(id)}::uuid`,
  );
  if (!rows.rows[0])
    throw new PublicFailure(
      404,
      'lab.world_not_found',
      'Lab or Entity not found',
    );
  return entityValue(rows.rows[0]);
}
export async function representation(
  tx: DbSession,
  id: string | null | undefined,
) {
  if (id == null) return;
  const rows = await tx.execute(
    sql`select id from lab.asset_representations where id=${worldId(id)}::uuid`,
  );
  if (!rows.rows.length)
    throw new PublicFailure(
      400,
      'lab.invalid_reference',
      'Use an existing representation',
    );
}
export async function registerBinding(
  tx: DbSession,
  entity: LabEntity['id'],
  definition: string,
  reality: string,
) {
  if (
    !['light', 'sensor', 'centrifuge'].includes(definition) ||
    reality !== 'simulated'
  )
    return;
  const id = randomUUID(),
    program = `${definition}.v1`;
  await tx.execute(
    sql`insert into lab.runtime_bindings(id,entity_id,program_id,source,definition_id,definition_version,definition) select ${id}::uuid,e.id,${program},${'simulated:' + program + ':' + id},e.definition_id,e.definition_version,e.definition from lab.entities e where e.id=${entity}::uuid`,
  );
}
export async function insertNode(
  tx: DbSession,
  lab: string,
  entity: string,
  representationId: string | null | undefined,
  placement: Placement,
): Promise<SceneNode> {
  const id = randomUUID();
  const rows = await tx.execute<SceneNode>(
    sql`insert into lab.scene_nodes(id,lab_id,entity_id,representation_id,placement) values(${id}::uuid,${lab}::uuid,${entity}::uuid,${representationId ?? null}::uuid,${JSON.stringify(placement)}::jsonb) returning id::text,lab_id::text,entity_id::text,representation_id::text,placement`,
  );
  await tx.execute(
    sql`update lab.labs set layout_version=layout_version+1 where id=${lab}::uuid`,
  );
  return rows.rows[0];
}
