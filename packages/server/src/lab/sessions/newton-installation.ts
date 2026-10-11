import { createHash, randomUUID } from 'node:crypto';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { loadLab, type WorldService } from '../world/use-cases.ts';
import { catalog } from '../world/catalog.ts';
import type { Installation } from './dto.ts';
import {
  newtonProfile,
  newtonVisualPoses,
  posePlacement,
} from './newton-profile.ts';

export async function createNewtonInstallationIn(
  tx: DbSession,
  world: WorldService,
  lab: string,
  representations: Record<string, string>,
  actor: string,
  now: string,
): Promise<Installation> {
  await loadLab(tx, lab);
  if (
    Object.keys(representations).length !== newtonProfile.body_order.length ||
    newtonProfile.body_order.some((key) => !representations[key])
  )
    throw new PublicFailure(
      400,
      'lab.newton_mapping_mismatch',
      'Provide all ten fixed Newton representations',
    );
  const capacity = await tx.execute<{ entities: number; nodes: number }>(
    sql`select (select count(*) from lab.entities where lab_id=${lab}::uuid)::int as entities,(select count(*) from lab.scene_nodes where lab_id=${lab}::uuid)::int as nodes`,
  );
  if (capacity.rows[0].entities > 996 || capacity.rows[0].nodes > 990)
    throw new PublicFailure(
      400,
      'lab.installation_capacity',
      'Lab cannot fit the fixed Newton scene',
    );
  for (const [index, key] of newtonProfile.body_order.entries()) {
    const rows = await tx.execute<{ sha256: string; size: number }>(
      sql`select r.sha256,r.size::float8 as size from lab.asset_representations r join labos_threejs_core.files f on f.id=r.file_id where r.id=${representations[key]}::uuid and f.state='ready'`,
    );
    if (
      !rows.rows[0] ||
      rows.rows[0].sha256 !== newtonProfile.visuals[index].sha256.slice(7) ||
      Number(rows.rows[0].size) !== newtonProfile.visuals[index].bytes
    )
      throw new PublicFailure(
        400,
        'lab.newton_representation_mismatch',
        'Use the exact versioned Newton scene representations',
      );
  }
  const robot = randomUUID(),
    vial = randomUUID(),
    rack = randomUUID(),
    mat = randomUUID();
  const entityIds = newtonProfile.body_order.map((_, i) =>
    i < 7 ? robot : [vial, rack, mat][i - 7],
  );
  const targets = newtonProfile.body_order.map((key, i) => ({
    object_key: i < 7 ? 'so101' : key,
    pose_key: key,
    entity_id: entityIds[i],
    node_id: randomUUID(),
    visual_target: 'node-root' as const,
    body_to_visual: newtonProfile.visuals[i].body_to_visual,
  }));
  for (const [index, name, definitionId] of [
    [0, 'SO-101', 'robot'],
    [7, 'Vial', 'labware'],
    [8, 'Four-hole rack', 'labware'],
    [9, 'Mat', 'model'],
  ] as const) {
    const definition = catalog.find((item) => item.id === definitionId)!;
    await tx.execute(
      sql`insert into lab.entities(id,lab_id,name,kind,reality,definition_id,definition_version,definition,configuration,representation_id,created_by,updated_by) values(${entityIds[index]}::uuid,${lab}::uuid,${name},${definition.category},'simulated',${definition.id},${definition.version},${JSON.stringify(definition)}::jsonb,'{}'::jsonb,${representations[newtonProfile.body_order[index]]}::uuid,${actor}::uuid,${actor}::uuid)`,
    );
  }
  const placements = newtonVisualPoses().map(posePlacement);
  for (const [index, target] of targets.entries())
    await tx.execute(
      sql`insert into lab.scene_nodes(id,lab_id,entity_id,representation_id,placement) values(${target.node_id}::uuid,${lab}::uuid,${target.entity_id}::uuid,${representations[target.pose_key]}::uuid,${JSON.stringify(placements[index])}::jsonb)`,
    );
  const metadata: Installation = {
    id: randomUUID(),
    lab_id: lab,
    package_id: 'so101-vial',
    package_version: '1',
    scene_hash:
      'sha256:' +
      createHash('sha256')
        .update(
          JSON.stringify({
            profile: newtonProfile.hash,
            targets,
            representations,
          }),
        )
        .digest('hex'),
    mapping_revision: 1,
    pose_keys: [...newtonProfile.body_order],
    joint_keys: [...newtonProfile.joint_order],
    targets,
    created_at: now,
    archived_at: null,
  };
  await tx.execute(
    sql`insert into lab.scene_installations(id,lab_id,metadata,created_by,created_at) values(${metadata.id}::uuid,${lab}::uuid,${JSON.stringify(metadata)}::jsonb,${actor}::uuid,${now}::timestamptz)`,
  );
  await tx.execute(
    sql`update lab.labs set layout_version=layout_version+1 where id=${lab}::uuid`,
  );
  return metadata;
}
