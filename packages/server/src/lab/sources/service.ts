import { randomUUID } from 'node:crypto';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { canonicalUuid } from '../../platform/uuid.ts';
import {
  accessIn,
  type AccessActor,
} from '../../core/api-keys/authentication.ts';
import {
  authenticateMachineIn,
  provisionMachineIn,
} from '../../core/machines/use-cases.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import { loadLab, type WorldService } from '../world/use-cases.ts';
import type {
  Source,
  SourceConnectionInput,
  SourceHeartbeatInput,
  SourceDisconnectInput,
} from './dto.ts';

export const sourcePresenceLimits = {
  heartbeatMillis: 1000,
  timeoutMillis: 5000,
  sourcesPerLab: 64,
} as const;
type Row = {
  id: string;
  lab_id: string;
  name: string;
  created_by: string;
  machine_id: string | null;
  source_run_id: string | null;
  connection_id: string | null;
  epoch: string;
  phase: Source['phase'];
  last_seen_at: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};
export type SourceGrant = Row & { machine_id: string };
const columns = sql`s.id::text,s.lab_id::text,s.name,s.created_by::text,s.machine_id::text,s.source_run_id::text,s.connection_id::text,s.epoch::text,s.phase,s.last_seen_at,s.created_at,m.expires_at,m.revoked_at`;
const denied = () =>
  new PublicFailure(403, 'lab.source_unauthorized', 'Source admission failed');

/** Source identity and presence never create or advance a device or simulation. */
export class SourceService {
  readonly world: WorldService;
  readonly serverUrl: string;
  private stopping = false;
  constructor(world: WorldService, serverUrl: string) {
    this.world = world;
    this.serverUrl = serverUrl;
  }
  async initialize() {
    await this.world.context.db.transaction(
      { id: 'sources:recover:' + randomUUID(), kind: 'startup' },
      (tx) =>
        tx.execute(
          sql`update lab.sources set connection_id=null where connection_id is not null`,
        ),
    );
  }
  async stop() {
    this.stopping = true;
    await this.world.context.db.transaction(
      {
        id: 'sources:stop:' + randomUUID(),
        kind: this.world.context.db.operationKind ?? 'background',
      },
      (tx) =>
        tx.execute(
          sql`update lab.sources set connection_id=null where connection_id is not null`,
        ),
    );
  }
  async machineRevoked(machine: string) {
    await this.world.context.db.transaction(
      {
        id: 'sources:revoke:' + randomUUID(),
        kind: this.world.context.db.operationKind ?? 'background',
      },
      (tx) =>
        tx.execute(
          sql`update lab.sources set connection_id=null where machine_id=${machine}::uuid`,
        ),
    );
  }
  private value(row: Row): Source {
    const now = Date.parse(this.world.context.clock.now());
    const authorization = !row.machine_id
      ? 'unconfigured'
      : row.revoked_at
        ? 'revoked'
        : Date.parse(row.expires_at!) <= now
          ? 'expired'
          : 'authorized';
    const connected =
      authorization === 'authorized' &&
      !!row.connection_id &&
      !!row.last_seen_at &&
      now - Date.parse(row.last_seen_at) < sourcePresenceLimits.timeoutMillis;
    return {
      id: row.id,
      lab_id: row.lab_id,
      name: row.name,
      connection_state: connected ? 'connected' : 'offline',
      authorization,
      credential_expires_at: row.expires_at ? utcInstant(row.expires_at) : null,
      phase: row.phase,
      source_run_id: row.source_run_id,
      connection_id: connected ? row.connection_id : null,
      epoch: row.epoch,
      last_seen_at: row.last_seen_at ? utcInstant(row.last_seen_at) : null,
      created_at: utcInstant(row.created_at),
    };
  }
  private async row(tx: DbSession, lab: string, id: string) {
    const result = await tx.execute<Row>(
      sql`select ${columns} from lab.sources s left join labos_threejs_core.machines m on m.id=s.machine_id where s.lab_id=${lab}::uuid and s.id=${id}::uuid`,
    );
    if (!result.rows[0])
      throw new PublicFailure(
        404,
        'lab.source_not_found',
        'Lab Source not found',
      );
    return result.rows[0];
  }
  private member<T>(
    headers: Headers,
    requestId: string,
    write: boolean,
    work: (tx: DbSession, actor: AccessActor) => Promise<T>,
  ) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.world.context,
          this.world.policy,
          headers,
          'lab:full',
          write,
        );
        return work(tx, actor);
      },
    );
  }
  async list(headers: Headers, requestId: string, lab: string) {
    return this.member(headers, requestId, false, async (tx) => {
      await loadLab(tx, lab);
      const rows = await tx.execute<Row>(
        sql`select ${columns} from lab.sources s left join labos_threejs_core.machines m on m.id=s.machine_id where s.lab_id=${lab}::uuid order by s.created_at,s.id`,
      );
      return { data: rows.rows.map((row) => this.value(row)) };
    });
  }
  async get(headers: Headers, requestId: string, lab: string, id: string) {
    return this.member(headers, requestId, false, async (tx) =>
      this.value(await this.row(tx, lab, id)),
    );
  }
  async register(
    headers: Headers,
    requestId: string,
    lab: string,
    name: string,
  ) {
    return this.member(headers, requestId, true, async (tx, actor) => {
      await loadLab(tx, lab);
      const count = await tx.execute<{ count: number }>(
        sql`select count(*)::int as count from lab.sources where lab_id=${lab}::uuid`,
      );
      if (count.rows[0].count >= sourcePresenceLimits.sourcesPerLab)
        throw new PublicFailure(
          429,
          'lab.source_capacity',
          'Lab Source capacity reached',
        );
      const id = randomUUID();
      await tx.execute(
        sql`insert into lab.sources(id,lab_id,name,created_by,created_at) values(${id}::uuid,${lab}::uuid,${name},${actor.user.id}::uuid,${this.world.context.clock.now()}::timestamptz)`,
      );
      await this.audit(tx, actor, requestId, id, 'register');
      return this.value(await this.row(tx, lab, id));
    });
  }
  async configuration(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
  ) {
    return this.member(headers, requestId, true, async (tx, actor) => {
      const source = await this.row(tx, lab, id),
        now = this.world.context.clock.now();
      if (source.machine_id)
        await tx.execute(
          sql`update labos_threejs_core.machines set revoked_at=coalesce(revoked_at,${now}::timestamptz) where id=${source.machine_id}::uuid`,
        );
      const generated = await provisionMachineIn(
        tx,
        actor.user.id,
        'Lab Source',
        now,
        'source',
      );
      await tx.execute(
        sql`update lab.sources set machine_id=${generated.machine.id}::uuid,connection_id=null where id=${id}::uuid`,
      );
      await this.audit(tx, actor, requestId, id, 'configure');
      return {
        format: 'lab-world-source-v1' as const,
        server_url: this.serverUrl,
        lab_id: lab,
        source_id: id,
        machine_id: generated.machine.id,
        credential: generated.credential,
        expires_at: generated.machine.expires_at,
      };
    });
  }
  async revoke(headers: Headers, requestId: string, lab: string, id: string) {
    return this.member(headers, requestId, true, async (tx, actor) => {
      const source = await this.row(tx, lab, id);
      if (source.machine_id)
        await tx.execute(
          sql`update labos_threejs_core.machines set revoked_at=coalesce(revoked_at,${this.world.context.clock.now()}::timestamptz) where id=${source.machine_id}::uuid`,
        );
      await tx.execute(
        sql`update lab.sources set connection_id=null where id=${id}::uuid`,
      );
      await this.audit(tx, actor, requestId, id, 'revoke');
    });
  }
  /** Future source-scoped modules reuse this grant; a source credential is not a full-Lab key. */
  async authenticateIn(
    tx: DbSession,
    headers: Headers,
    lab: string,
    id: string,
    machine: string,
  ) {
    if (this.stopping)
      throw new PublicFailure(
        503,
        'lab.source_unavailable',
        'Source admission is stopping',
      );
    const credential = await authenticateMachineIn(
      tx,
      machine,
      headers,
      this.world.context.clock.now(),
      'source',
    );
    let source: Row;
    try {
      source = await this.row(tx, lab, id);
    } catch (error) {
      if (
        error instanceof PublicFailure &&
        error.code === 'lab.source_not_found'
      )
        throw denied();
      throw error;
    }
    if (source.machine_id !== credential.id) throw denied();
    return { ...source, machine_id: credential.id } satisfies SourceGrant;
  }
  async requireConnectionIn(
    tx: DbSession,
    headers: Headers,
    lab: string,
    id: string,
    input: SourceDisconnectInput,
  ) {
    const source = await this.authenticateIn(
      tx,
      headers,
      lab,
      id,
      input.machine_id,
    );
    if (
      source.connection_id !== canonicalUuid(input.connection_id) ||
      source.epoch !== input.epoch ||
      this.value(source).connection_state !== 'connected'
    )
      throw denied();
    return source;
  }
  async connect(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    input: SourceConnectionInput,
  ) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const source = await this.authenticateIn(
          tx,
          headers,
          lab,
          id,
          input.machine_id,
        );
        if (this.value(source).connection_state === 'connected')
          throw new PublicFailure(
            409,
            'lab.source_connection_conflict',
            'This Source already has a healthy connection',
          );
        if (BigInt(source.epoch) === 18446744073709551615n)
          throw new PublicFailure(
            503,
            'lab.source_epoch_capacity',
            'Source epoch capacity reached',
          );
        const connection = randomUUID(),
          epoch = String(BigInt(source.epoch) + 1n);
        await tx.execute(
          sql`update lab.sources set source_run_id=${input.source_run_id}::uuid,connection_id=${connection}::uuid,epoch=${epoch}::numeric,phase=${input.phase},last_seen_at=${this.world.context.clock.now()}::timestamptz where id=${id}::uuid`,
        );
        return {
          connection_id: connection,
          epoch,
          heartbeat_interval_ms: sourcePresenceLimits.heartbeatMillis,
        };
      },
    );
  }
  async heartbeat(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    input: SourceHeartbeatInput,
  ) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await this.requireConnectionIn(tx, headers, lab, id, input);
        await tx.execute(
          sql`update lab.sources set phase=${input.phase},last_seen_at=${this.world.context.clock.now()}::timestamptz where id=${id}::uuid`,
        );
        return this.value(await this.row(tx, lab, id));
      },
    );
  }
  async disconnect(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    input: SourceDisconnectInput,
  ) {
    return this.world.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const source = await this.authenticateIn(
          tx,
          headers,
          lab,
          id,
          input.machine_id,
        );
        if (
          source.epoch !== input.epoch ||
          (source.connection_id !== null &&
            source.connection_id !== canonicalUuid(input.connection_id))
        )
          throw denied();
        await tx.execute(
          sql`update lab.sources set connection_id=null where id=${id}::uuid`,
        );
      },
    );
  }
  private audit(
    tx: DbSession,
    actor: AccessActor,
    requestId: string,
    id: string,
    action: string,
  ) {
    return databaseAudit.record(tx, {
      actorId: actor.user.id,
      actorType: actor.isApiKey ? 'agent' : 'user',
      action: 'lab.source.' + action,
      resourceType: 'lab.source',
      resourceId: id,
      requestId,
      correlationId: requestId,
      metadata: {},
    });
  }
}
