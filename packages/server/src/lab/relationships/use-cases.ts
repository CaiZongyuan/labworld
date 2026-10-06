import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { worldId } from '../world/entities.ts';
import {
  validRelationships,
  type EntityRelationship,
  type LayoutRelationship,
  type RelationshipEntity,
} from './domain.ts';
export async function loadRelationships(tx: DbSession, lab: string) {
  const rows = await tx.execute<EntityRelationship>(
    sql`select id::text,lab_id::text,source_id::text,target_id::text,kind,source,registered_by::text,registered_at from lab.entity_relationships where lab_id=${lab}::uuid order by id`,
  );
  return rows.rows.map((row) => ({
    ...row,
    registered_at: utcInstant(row.registered_at),
  }));
}
export async function saveRelationships(
  tx: DbSession,
  lab: string,
  actor: string,
  input: LayoutRelationship[],
) {
  if (input.length > 1000)
    throw new PublicFailure(400, 'lab.invalid_input', 'Too many relationships');
  const relationships = input.map((row) => ({
    ...row,
    id: worldId(row.id),
    source_id: worldId(row.source_id),
    target_id: worldId(row.target_id),
  }));
  const entities = await tx.execute<RelationshipEntity>(
    sql`select id::text,kind,reality,definition_id from lab.entities where lab_id=${lab}::uuid`,
  );
  if (!validRelationships(entities.rows, relationships))
    throw new PublicFailure(
      400,
      'lab.invalid_reference',
      'Use legal relationships within this Lab',
    );
  const ids = JSON.stringify(relationships.map((row) => row.id)),
    requested = new Map(relationships.map((row) => [row.id, row]));
  const existing = await tx.execute<EntityRelationship>(
    sql`select id::text,lab_id::text,source_id::text,target_id::text,kind from lab.entity_relationships where id in(select value::uuid from jsonb_array_elements_text(${ids}::jsonb))`,
  );
  for (const row of existing.rows) {
    const candidate = requested.get(row.id)!;
    if (
      row.lab_id !== lab ||
      row.source_id !== candidate.source_id ||
      row.target_id !== candidate.target_id ||
      row.kind !== candidate.kind
    )
      throw new PublicFailure(
        400,
        'lab.invalid_reference',
        'An existing relationship identity cannot be reassigned',
      );
  }
  await tx.execute(
    sql`delete from lab.entity_relationships where lab_id=${lab}::uuid and id not in(select value::uuid from jsonb_array_elements_text(${ids}::jsonb))`,
  );
  const saved = await tx.execute(
    sql`insert into lab.entity_relationships(id,lab_id,source_id,target_id,kind,registered_by) select r.id::uuid,${lab}::uuid,r.source_id::uuid,r.target_id::uuid,r.kind,${actor}::uuid from jsonb_to_recordset(${JSON.stringify(relationships)}::jsonb) as r(id text,source_id text,target_id text,kind text) on conflict(id) do update set id=excluded.id where entity_relationships.lab_id=excluded.lab_id and entity_relationships.source_id=excluded.source_id and entity_relationships.target_id=excluded.target_id and entity_relationships.kind=excluded.kind returning id`,
  );
  if (saved.rows.length !== relationships.length)
    throw new PublicFailure(
      400,
      'lab.invalid_reference',
      'Relationship changed before publication',
    );
}
