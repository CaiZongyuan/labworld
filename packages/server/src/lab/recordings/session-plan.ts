import { randomUUID } from 'node:crypto';
import {
  sql,
  type Database,
  type DbSession,
  type DbOperation,
} from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import type { CaptureHost } from './capture-plan.ts';
type Row = Record<string, unknown>;
type State = Record<string, Row[]>;
class SessionPlan<T> extends Error {
  value: T;
  before: State;
  after: State;
  at: string;
  constructor(value: T, before: State, after: State, at: string) {
    super('recording_session_plan');
    this.value = value;
    this.before = before;
    this.after = after;
    this.at = at;
  }
}
const encoded = (value: unknown) => JSON.stringify(value);
async function state(tx: DbSession, id: string, requestId: string) {
  const rows = await tx.execute<{
    state: State;
  }>(sql`with session_ids as(select id from lab.simulation_sessions where id=${id}::uuid or id=(select successor_session_id from lab.simulation_sessions where id=${id}::uuid)) select jsonb_build_object(
  'sessions',(select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('epoch',s.epoch::text) order by s.id),'[]'::jsonb) from lab.simulation_sessions s where s.id in(select id from session_ids)),
  'leases',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('epoch',l.epoch::text) order by l.id),'[]'::jsonb) from lab.publisher_leases l where l.session_id in(select id from session_ids)),
  'epoch',(select jsonb_agg(to_jsonb(e)||jsonb_build_object('value',e.value::text)) from lab.publisher_epoch e),
  'machines',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from labos_threejs_core.machines m where m.id in(select machine_id from lab.simulation_sessions where id in(select id from session_ids))),
  'objects',(select coalesce(jsonb_agg(to_jsonb(o) order by o.session_id,o.node_id),'[]'::jsonb) from lab.session_objects o where o.session_id in(select id from session_ids)),
  'assets',(select coalesce(jsonb_agg(to_jsonb(a) order by a.session_id,a.representation_id),'[]'::jsonb) from lab.session_assets a where a.session_id in(select id from session_ids)),
  'stages',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from lab.recording_stages r where r.lab_id=(select lab_id from lab.simulation_sessions where id=${id}::uuid)),
  'recordings',(select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('event_sequence',r.event_sequence::text) order by r.id),'[]'::jsonb) from lab.recordings r where r.session_id in(select id from session_ids)),
  'resources',(select coalesce(jsonb_agg(to_jsonb(r) order by r.recording_id,r.file_id),'[]'::jsonb) from lab.recording_resources r where r.recording_id in(select id from lab.recordings where session_id in(select id from session_ids))),
  'references',(select coalesce(jsonb_agg(to_jsonb(r) order by r.file_id,r.owner_id),'[]'::jsonb) from labos_threejs_core.file_references r where r.owner_type='lab.recording' and r.owner_id in(select id::text from lab.recordings where session_id in(select id from session_ids) union select id::text from lab.recording_stages where lab_id=(select lab_id from lab.simulation_sessions where id=${id}::uuid))),
  'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from labos_threejs_core.audit_events a where a.request_id=${requestId})
) as state`);
  const value = rows.rows[0].state;
  if (Buffer.byteLength(encoded(value)) > 4 * 1024 * 1024)
    throw new Error('recording_session_plan_capacity');
  return value;
}
const table = {
  sessions: 'lab.simulation_sessions',
  leases: 'lab.publisher_leases',
  epoch: 'lab.publisher_epoch',
  machines: 'labos_threejs_core.machines',
  objects: 'lab.session_objects',
  assets: 'lab.session_assets',
  audit: 'labos_threejs_core.audit_events',
  recordings: 'lab.recordings',
  resources: 'lab.recording_resources',
  references: 'labos_threejs_core.file_references',
  stages: 'lab.recording_stages',
};
const keys: Record<string, string[]> = {
  sessions: ['id'],
  leases: ['id'],
  epoch: ['singleton'],
  machines: ['id'],
  objects: ['session_id', 'node_id'],
  assets: ['session_id', 'representation_id'],
  audit: ['id'],
  recordings: ['id'],
  resources: ['recording_id', 'file_id'],
  references: ['file_id', 'owner_type', 'owner_id'],
  stages: ['id'],
};
const identity = (name: string, row: Row) =>
  keys[name].map((k) => String(row[k])).join(':');
async function apply(tx: DbSession, before: State, after: State) {
  for (const name of ['objects', 'assets', 'stages']) {
    const columns = keys[name],
      parts = table[name as keyof typeof table].split('.');
    for (const old of before[name])
      if (
        !after[name].some((row) => identity(name, row) === identity(name, old))
      )
        await tx.execute(
          sql`delete from ${sql.identifier(parts[0])}.${sql.identifier(parts[1])} t using jsonb_populate_record(null::${sql.identifier(parts[0])}.${sql.identifier(parts[1])},${encoded(old)}::jsonb)x where ${sql.join(
            columns.map(
              (k) => sql`t.${sql.identifier(k)}=x.${sql.identifier(k)}`,
            ),
            sql` and `,
          )}`,
        );
  }
  for (const name of [
    'machines',
    'epoch',
    'sessions',
    'leases',
    'objects',
    'assets',
    'recordings',
    'resources',
    'references',
    'audit',
  ]) {
    const columns = keys[name],
      parts = table[name as keyof typeof table].split('.'),
      previous = new Map(before[name].map((r) => [identity(name, r), r]));
    const rows = after[name].filter(
      (row) => encoded(previous.get(identity(name, row))) !== encoded(row),
    );
    rows.sort(
      (a, b) =>
        Number(!previous.has(identity(name, a))) -
        Number(!previous.has(identity(name, b))),
    );
    for (const row of rows) {
      if (!previous.has(identity(name, row)))
        await tx.execute(
          sql`insert into ${sql.identifier(parts[0])}.${sql.identifier(parts[1])} select x.* from jsonb_populate_record(null::${sql.identifier(parts[0])}.${sql.identifier(parts[1])},${encoded(row)}::jsonb)x`,
        );
      else {
        const values = Object.keys(row).filter((k) => !columns.includes(k));
        await tx.execute(
          sql`update ${sql.identifier(parts[0])}.${sql.identifier(parts[1])} t set ${sql.join(
            values.map((k) => sql`${sql.identifier(k)}=x.${sql.identifier(k)}`),
            sql`, `,
          )} from jsonb_populate_record(null::${sql.identifier(parts[0])}.${sql.identifier(parts[1])},${encoded(row)}::jsonb)x where ${sql.join(
            columns.map(
              (k) => sql`t.${sql.identifier(k)}=x.${sql.identifier(k)}`,
            ),
            sql` and `,
          )}`,
        );
      }
    }
  }
}
/** Session metadata plans never serialize machine credentials or mutable snapshots into events. */
export async function recordedSessionTransaction<T>(
  db: Database,
  host: CaptureHost,
  operation: DbOperation,
  lab: string,
  id: string,
  work: (tx: DbSession) => Promise<T>,
  validate?: (tx: DbSession) => Promise<unknown>,
): Promise<T> {
  return host.gate([lab], async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let plan: SessionPlan<T>;
      try {
        await db.transaction(operation, async (tx) => {
          const before = await state(tx, id, operation.id),
            at = utcInstant(
              (await tx.execute<{ at: string }>(sql`select now()::text as at`))
                .rows[0].at,
            ),
            value = await work(tx),
            after = await state(tx, id, operation.id);
          throw new SessionPlan(value, before, after, at);
        });
        throw new Error('recording_session_plan_missing');
      } catch (error) {
        if (!(error instanceof SessionPlan)) throw error;
        plan = error as SessionPlan<T>;
      }
      const events = plan.after.sessions
        .filter(
          (row) =>
            encoded(
              plan.before.sessions.find((before) => before.id === row.id),
            ) !== encoded(row),
        )
        .map((row) => {
          const event = Object.fromEntries(
            Object.entries(row).filter(
              ([key]) => key !== 'snapshot' && key !== 'started_by',
            ),
          );
          return {
            event_id: randomUUID(),
            event_type: 'session.changed' as const,
            entity_id: null,
            recorded_at: plan.at,
            sim_time_ns: null,
            event: { ...event, session_id: row.id },
          };
        });
      const batches = await host.prepare(events);
      try {
        await db.transaction(operation, async (tx) => {
          await validate?.(tx);
          if (
            encoded(await state(tx, id, operation.id)) !== encoded(plan.before)
          )
            throw new SessionChanged();
          await apply(tx, plan.before, plan.after);
          await host.witness(tx, batches);
        });
      } catch (error) {
        await host.abort(batches);
        if (error instanceof SessionChanged && attempt === 0) continue;
        throw error;
      }
      try {
        await host.commit(batches);
      } catch (error) {
        host.failed(
          'recording_session_event_commit_failed',
          batches.map((b) => b.recording_id),
        );
        throw error;
      }
      return plan.value;
    }
    throw new Error('recording_session_conflict');
  });
}
class SessionChanged extends Error {}
