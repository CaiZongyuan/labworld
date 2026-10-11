import { createHash, randomUUID } from 'node:crypto';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { representation, worldId } from '../world/entities.ts';
import { catalog } from '../world/catalog.ts';
import { loadLab, type WorldService } from '../world/use-cases.ts';
import {
  SimulationSessionSnapshot,
  type Installation,
  type Session,
  type Snapshot,
  type Parameters,
} from './dto.ts';
import type { MotionPose } from '../../../../contracts/src/motion/index.ts';
export const sessionFailure = (
  code: string,
  message: string,
  status: 400 | 403 | 404 | 409 | 429 | 503 = 409,
) => new PublicFailure(status, 'lab.' + code, message);
export const sessionColumns = sql`id::text,lab_id::text,installation_id::text,machine_id::text,status,revision,epoch::text,lease_id::text,snapshot,started_at,ended_at,reason,successor_session_id::text`;
export function sessionValue(row: Session): Session {
  return {
    ...row,
    revision: Number(row.revision),
    started_at: utcInstant(row.started_at),
    ended_at: row.ended_at ? utcInstant(row.ended_at) : null,
  };
}
export async function sessionIn(tx: DbSession, lab: string, id: string) {
  const result = await tx.execute<Session>(
    sql`select ${sessionColumns} from lab.simulation_sessions where id=${worldId(id)}::uuid and lab_id=${worldId(lab)}::uuid`,
  );
  if (!result.rows[0])
    throw sessionFailure(
      'session_not_found',
      'Simulation Session not found',
      404,
    );
  return sessionValue(result.rows[0]);
}
export async function installationIn(tx: DbSession, lab: string, id: string) {
  const result = await tx.execute<{
    metadata: Installation;
    archived_at: string | null;
  }>(
    sql`select metadata,archived_at from lab.scene_installations where id=${worldId(id)}::uuid and lab_id=${worldId(lab)}::uuid`,
  );
  if (!result.rows[0])
    throw sessionFailure(
      'installation_not_found',
      'Scene Installation not found',
      404,
    );
  const value = result.rows[0];
  return {
    ...value.metadata,
    archived_at: value.archived_at ? utcInstant(value.archived_at) : null,
  };
}
export async function createInstallationIn(
  tx: DbSession,
  world: WorldService,
  labId: string,
  representationId: string,
  actor: string,
  now: string,
) {
  const lab = await loadLab(tx, labId);
  await representation(tx, representationId);
  const count = await tx.execute<{ entities: number; nodes: number }>(
    sql`select (select count(*) from lab.entities where lab_id=${lab.id}::uuid) as entities,(select count(*) from lab.scene_nodes where lab_id=${lab.id}::uuid) as nodes`,
  );
  if (Number(count.rows[0].entities) > 980 || Number(count.rows[0].nodes) > 980)
    throw sessionFailure(
      'installation_capacity',
      'Lab cannot fit the fixed scene',
      400,
    );
  const definition = catalog.find((entry) => entry.id === 'model')!;
  const targets = Array.from({ length: 20 }, (_, i) => ({
    object_key: `synthetic/body/${String(i).padStart(2, '0')}`,
    pose_key: `synthetic/body/${String(i).padStart(2, '0')}`,
    entity_id: randomUUID(),
    node_id: randomUUID(),
    visual_target: 'node-root' as const,
    body_to_visual: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  }));
  const rows = targets.map((target, i) => ({
    ...target,
    name: `Synthetic body ${String(i).padStart(2, '0')}`,
    placement: {
      position: [((i % 5) - 2) * 1.6, 0.65, (Math.floor(i / 5) - 1.5) * 1.4],
      rotation: [0, i * 0.1, 0],
      scale: [0.35, 0.35, 0.35],
    },
  }));
  await tx.execute(
    sql`insert into lab.entities(id,lab_id,name,kind,reality,definition_id,definition_version,definition,configuration,representation_id,created_by,updated_by) select x.entity_id,${lab.id}::uuid,x.name,${definition.category},'simulated',${definition.id},${definition.version},${JSON.stringify(definition)}::jsonb,'{}'::jsonb,${representationId}::uuid,${actor}::uuid,${actor}::uuid from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(entity_id uuid,name text)`,
  );
  await tx.execute(
    sql`insert into lab.scene_nodes(id,lab_id,entity_id,representation_id,placement) select x.node_id,${lab.id}::uuid,x.entity_id,${representationId}::uuid,x.placement from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(node_id uuid,entity_id uuid,placement jsonb)`,
  );
  const metadata: Installation = {
    id: randomUUID(),
    lab_id: lab.id,
    package_id: 'development-synthetic',
    package_version: '1',
    scene_hash:
      'sha256:' +
      createHash('sha256')
        .update(
          JSON.stringify({
            package: 'development-synthetic/1',
            representationId,
            targets,
          }),
        )
        .digest('hex'),
    mapping_revision: 1,
    pose_keys: targets.map((t) => t.pose_key),
    joint_keys: Array.from({ length: 6 }, (_, i) => `synthetic/joint/${i}`),
    targets,
    created_at: now,
    archived_at: null,
  };
  await tx.execute(
    sql`insert into lab.scene_installations(id,lab_id,metadata,created_by,created_at) values(${metadata.id}::uuid,${lab.id}::uuid,${JSON.stringify(metadata)}::jsonb,${actor}::uuid,${now}::timestamptz)`,
  );
  await tx.execute(
    sql`update lab.labs set layout_version=layout_version+1 where id=${lab.id}::uuid`,
  );
  return metadata;
}
function pose(placement: {
  position: number[];
  rotation: number[];
}): MotionPose {
  const [x, y, z] = placement.rotation.map((a) => a / 2),
    c1 = Math.cos(x),
    c2 = Math.cos(y),
    c3 = Math.cos(z),
    s1 = Math.sin(x),
    s2 = Math.sin(y),
    s3 = Math.sin(z);
  return {
    position: placement.position as [number, number, number],
    quaternion: [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    ],
  };
}
export async function snapshotIn(
  tx: DbSession,
  world: WorldService,
  installation: Installation,
  parameters: Parameters,
): Promise<Snapshot> {
  if (installation.archived_at)
    throw sessionFailure(
      'installation_unavailable',
      'Scene Installation is archived',
    );
  const current = await world.snapshotIn(tx, installation.lab_id),
    nodes = new Map(current.nodes.map((n) => [String(n.id), n])),
    entities = new Map(current.entities.map((e) => [e.id, e]));
  const initial = installation.targets.map((target) => {
    const node = nodes.get(target.node_id),
      entity = entities.get(target.entity_id);
    if (
      !node ||
      node.entity_id !== target.entity_id ||
      !entity ||
      entity.archived_at
    )
      throw sessionFailure(
        'installation_unavailable',
        'Installed objects are unavailable',
      );
    return pose(node.placement as { position: number[]; rotation: number[] });
  });
  const input = {
    installation,
    world: current,
    parameters,
    initial_poses: initial,
    initial_joints: installation.joint_keys.map(() => 0),
  };
  return SimulationSessionSnapshot.parse({
    ...input,
    hash:
      'sha256:' +
      createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  });
}
export async function reserveSessionIn(
  tx: DbSession,
  lab: string,
  installation: string,
  machine: string,
  snapshot: Snapshot,
  actor: string,
  now: string,
  id: string = randomUUID(),
) {
  lab = worldId(lab);
  machine = worldId(machine);
  // SDK lifecycle consumers bound a complete event to 1 MiB; leave room for lifecycle fields.
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024 - 2048)
    throw new PublicFailure(
      413,
      'lab.session_snapshot_too_large',
      'Session snapshot exceeds the lifecycle payload limit',
    );
  const active = await tx.execute<{ id: string; lab_id: string }>(
    sql`select id,lab_id::text from lab.simulation_sessions where ended_at is null`,
  );
  if (active.rows.some((session) => session.lab_id === lab))
    throw sessionFailure(
      'session_conflict',
      'This Lab already has an active Simulation Session',
    );
  if (active.rows.length >= 8)
    throw sessionFailure(
      'session_capacity',
      'Active Simulation Session capacity reached',
      429,
    );
  const available = await tx.execute(
    sql`select id from labos_threejs_core.machines where id=${machine}::uuid and revoked_at is null and expires_at>${now}::timestamptz`,
  );
  if (!available.rows.length)
    throw sessionFailure(
      'machine_unavailable',
      'Use an available independent machine',
      400,
    );
  const result = await tx.execute<Session>(
    sql`insert into lab.simulation_sessions(id,lab_id,installation_id,machine_id,snapshot,status,started_by,started_at) values(${id}::uuid,${lab}::uuid,${installation}::uuid,${machine}::uuid,${JSON.stringify(snapshot)}::jsonb,'starting',${actor}::uuid,${now}::timestamptz) returning ${sessionColumns}`,
  );
  await tx.execute(
    sql`insert into lab.session_objects(session_id,node_id,entity_id) select ${id}::uuid,x.node_id,x.entity_id from jsonb_to_recordset(${JSON.stringify(snapshot.installation.targets)}::jsonb) as x(node_id uuid,entity_id uuid)`,
  );
  const assets = snapshot.world.assets.map((a) => a.representation);
  if (assets.length)
    await tx.execute(
      sql`insert into lab.session_assets(session_id,representation_id,file_id) select ${id}::uuid,x.id,x.file_id from jsonb_to_recordset(${JSON.stringify(assets)}::jsonb) as x(id uuid,file_id uuid)`,
    );
  return sessionValue(result.rows[0]);
}
export async function endSessionIn(
  tx: DbSession,
  id: string,
  status: 'stopped' | 'interrupted' | 'reset',
  reason: string,
  now: string,
  successor: string | null = null,
) {
  const result = await tx.execute<Session>(
    sql`update lab.simulation_sessions set status=${status},reason=${reason},ended_at=${now}::timestamptz,revision=revision+1,successor_session_id=${successor}::uuid where id=${id}::uuid and ended_at is null returning ${sessionColumns}`,
  );
  await tx.execute(
    sql`update lab.publisher_leases set ended_at=${now}::timestamptz where session_id=${id}::uuid and ended_at is null`,
  );
  await tx.execute(
    sql`delete from lab.session_objects where session_id=${id}::uuid`,
  );
  return result.rows[0] ? sessionValue(result.rows[0]) : undefined;
}
