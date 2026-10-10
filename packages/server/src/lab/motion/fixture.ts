import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  accessIn,
  revalidateIn,
  type AccessActor,
} from '../../core/api-keys/authentication.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { sql } from '../../platform/db/index.ts';
import { loadLab, type WorldService } from '../world/use-cases.ts';
import { representation } from '../world/entities.ts';
import { catalog } from '../world/catalog.ts';
import type { MotionTarget } from '../../../../contracts/src/motion/index.ts';

export type MotionFixture = {
  session_id: string;
  lab_id: string;
  scene_hash: string;
  mapping_revision: number;
  pose_keys: string[];
  joint_keys: string[];
  targets: MotionTarget[];
};
type Fixture = { metadata: MotionFixture; owner: string };
type Ticket = {
  fixture: Fixture;
  actor: AccessActor;
  role: 'viewer' | 'publisher';
  rate: 15 | 30;
  expires: number;
};
export function loopback(address: string | undefined) {
  return (
    !!address &&
    (address === '127.0.0.1' ||
      address === '::1' ||
      address === '::ffff:127.0.0.1')
  );
}
const failure = (
  code: string,
  message: string,
  status: 400 | 403 | 404 | 409 | 429 = 400,
) => new PublicFailure(status, 'lab.' + code, message);
// This opt-in fixture owns only an in-memory motion binding. Lab identity, assets,
// membership, credentials and persistent Placement remain in the existing services.
export class MotionFixtures {
  readonly world: WorldService;
  readonly enabled: boolean;
  private fixtures = new Map<string, Fixture>();
  private tickets = new Map<string, Ticket>();
  private creating = new Set<string>();
  private stopped = false;
  constructor(world: WorldService, enabled: boolean) {
    this.world = world;
    this.enabled = enabled;
  }
  guard(peer: string | undefined, headers?: Headers) {
    if (!this.enabled || this.stopped)
      throw failure(
        'motion_fixture_disabled',
        'Motion fixture is disabled',
        404,
      );
    if (
      !loopback(peer) ||
      ['forwarded', 'x-forwarded-for', 'x-real-ip'].some((name) =>
        headers?.has(name),
      )
    )
      throw failure(
        'motion_fixture_disabled',
        'Motion fixture is unavailable',
        404,
      );
  }
  private fixture(lab: string, session?: string) {
    const fixture = this.fixtures.get(lab);
    if (!fixture || (session && fixture.metadata.session_id !== session))
      throw failure(
        'motion_fixture_not_found',
        'Motion fixture not found',
        404,
      );
    return fixture;
  }
  async get(headers: Headers, requestId: string, lab: string) {
    await this.world.world(headers, requestId, lab);
    return this.fixture(lab).metadata;
  }
  async create(
    headers: Headers,
    requestId: string,
    lab: string,
    representationId: string,
  ) {
    if (this.creating.has(lab))
      throw failure(
        'motion_fixture_conflict',
        'Motion fixture creation is already in progress',
        409,
      );
    this.creating.add(lab);
    try {
      const result = await this.world.context.db.transaction(
        { id: requestId, kind: 'request' },
        async (tx) => {
          const actor = await accessIn(
            tx,
            this.world.context,
            this.world.policy,
            headers,
            'lab:full',
            true,
          );
          const current = await loadLab(tx, lab);
          const existing = this.fixtures.get(current.id);
          if (existing) return existing.metadata;
          if (this.fixtures.size >= 8)
            throw failure(
              'motion_fixture_capacity',
              'Motion fixture capacity reached',
              429,
            );
          await representation(tx, representationId);
          const counts = await tx.execute<{ entities: number; nodes: number }>(
            sql`select (select count(*) from lab.entities where lab_id=${current.id}::uuid) as entities,(select count(*) from lab.scene_nodes where lab_id=${current.id}::uuid) as nodes`,
          );
          if (
            Number(counts.rows[0].entities) > 980 ||
            Number(counts.rows[0].nodes) > 980
          )
            throw failure(
              'motion_fixture_capacity',
              'Lab capacity cannot fit the fixture',
              400,
            );
          const definition = catalog.find((entry) => entry.id === 'model')!;
          const targets: MotionTarget[] = Array.from(
            { length: 20 },
            (_, index) => ({
              pose_key: `synthetic/body/${String(index).padStart(2, '0')}`,
              entity_id: randomUUID(),
              node_id: randomUUID(),
              visual_target: 'node-root',
            }),
          );
          const rows = targets.map((target, i) => ({
            ...target,
            name: `Synthetic body ${String(i).padStart(2, '0')}`,
            placement: {
              position: [
                ((i % 5) - 2) * 1.6 + 0.45 * Math.sin(i * 0.2),
                0.65 + 0.15 * Math.sin(i * 0.2),
                (Math.floor(i / 5) - 1.5) * 1.4 + 0.35 * Math.cos(i * 0.2),
              ],
              rotation: [0, i * 0.1, 0],
              scale: [0.35, 0.35, 0.35],
            },
          }));
          await tx.execute(
            sql`insert into lab.entities(id,lab_id,name,kind,reality,definition_id,definition_version,definition,configuration,representation_id,created_by,updated_by) select x.entity_id,${current.id}::uuid,x.name,${definition.category},'simulated',${definition.id},${definition.version},${JSON.stringify(definition)}::jsonb,'{}'::jsonb,${representationId}::uuid,${actor.user.id}::uuid,${actor.user.id}::uuid from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(entity_id uuid,name text)`,
          );
          await tx.execute(
            sql`insert into lab.scene_nodes(id,lab_id,entity_id,representation_id,placement) select x.node_id,${current.id}::uuid,x.entity_id,${representationId}::uuid,x.placement from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(node_id uuid,entity_id uuid,placement jsonb)`,
          );
          await tx.execute(
            sql`update lab.labs set layout_version=layout_version+1 where id=${current.id}::uuid`,
          );
          const metadata: MotionFixture = {
            session_id: randomUUID(),
            lab_id: current.id,
            scene_hash:
              'sha256:' +
              createHash('sha256')
                .update(JSON.stringify({ representationId, targets }))
                .digest('hex'),
            mapping_revision: 1,
            pose_keys: targets.map((target) => target.pose_key),
            joint_keys: Array.from(
              { length: 6 },
              (_, i) => `synthetic/joint/${i}`,
            ),
            targets,
          };
          // Publish only after the enclosing transaction has committed (below).
          return { metadata, owner: actor.user.id };
        },
      );
      if ('metadata' in result) {
        if (this.stopped)
          throw failure(
            'motion_fixture_disabled',
            'Motion fixture is disabled',
            404,
          );
        this.fixtures.set(result.metadata.lab_id, result);
        return result.metadata;
      }
      return result;
    } finally {
      this.creating.delete(lab);
    }
  }
  async issue(
    headers: Headers,
    requestId: string,
    lab: string,
    session: string,
    role: Ticket['role'],
    rate: 15 | 30,
  ) {
    const actor = await this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
          true,
        );
        await loadLab(tx, lab);
        return actor;
      },
    );
    const fixture = this.fixture(lab, session);
    if (role === 'publisher' && fixture.owner !== actor.user.id)
      throw failure(
        'motion_publisher_forbidden',
        'Only the fixture creator can admit its Publisher',
        403,
      );
    for (const [key, value] of this.tickets)
      if (value.expires <= performance.now()) this.tickets.delete(key);
    if (this.tickets.size >= 256)
      throw failure(
        'motion_ticket_capacity',
        'Motion ticket capacity reached',
        429,
      );
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      fixture,
      actor,
      role,
      rate,
      expires: performance.now() + 30_000,
    });
    return {
      ticket,
      expires_in_seconds: 30,
      websocket_path: `/api/v1/lab/motion/sessions/${session}/${role}`,
    };
  }
  async consume(ticket: string, session: string, role: Ticket['role']) {
    const record = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !record ||
      this.stopped ||
      record.expires <= performance.now() ||
      record.role !== role ||
      record.fixture.metadata.session_id !== session
    )
      throw failure('motion_unauthorized', 'Motion admission failed', 403);
    await this.world.context.db.transaction(
      { id: randomUUID(), kind: 'request' },
      (tx) =>
        revalidateIn(
          tx,
          this.world.context,
          this.world.policy,
          record.actor,
          'lab:full',
        ),
    );
    if (this.stopped)
      throw failure('motion_unauthorized', 'Motion admission failed', 403);
    return { metadata: record.fixture.metadata, rate: record.rate };
  }
  stop() {
    this.stopped = true;
    this.tickets.clear();
    this.fixtures.clear();
  }
}
