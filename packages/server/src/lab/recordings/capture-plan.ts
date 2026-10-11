import { randomUUID } from 'node:crypto';
import {
  sql,
  type Database,
  type DbOperation,
  type DbSession,
} from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import type { RecordingCapture, RecordingCaptureScope } from './capture.ts';
import type { RecordingBusinessEvent } from './source.ts';

type Row = Record<string, unknown>;
type State = Record<string, Row[]>;
export type PreparedEventBatch = {
  recording_id: string;
  batch_id: string;
  first_event_sequence: string;
  event_count: number;
  sha256: string;
  events: RecordingBusinessEvent[];
  marked?: boolean;
  marking?: Promise<unknown>;
  finalizerFinished?: boolean;
};
export interface CaptureHost {
  hasActiveRecordings(): boolean;
  covers(entity: string): boolean;
  gate<T>(labs: string[], work: () => Promise<T>): Promise<T>;
  scope(
    operation: DbOperation,
    scope: RecordingCaptureScope,
  ): Promise<{ lab: string; entities: string[] } | undefined>;
  prepare(events: RecordingBusinessEvent[]): Promise<PreparedEventBatch[]>;
  witness(tx: DbSession, batches: PreparedEventBatch[]): Promise<void>;
  commit(batches: PreparedEventBatch[]): Promise<void>;
  abort(batches: PreparedEventBatch[]): Promise<void>;
  failed(reason: string, recordingIds?: string[]): void;
}
const tables = {
  runs: 'lab.program_runs',
  commands: 'lab.device_commands',
  tasks: 'lab.device_tasks',
  results: 'lab.device_task_results',
  observations: 'lab.current_observations',
  history: 'lab.observation_history',
  events: 'lab.device_events',
  audit: 'labos_threejs_core.audit_events',
} as const;
const key = (kind: string, row: Row) =>
  String(kind === 'observations' ? row.entity_id : row.id);
const encoded = (value: unknown) => JSON.stringify(value);
class PlannedRollback<T> extends Error {
  readonly value: T;
  readonly before: State;
  readonly after: State;
  readonly at: string;
  constructor(value: T, before: State, after: State, at: string) {
    super('recording_plan_rollback');
    this.value = value;
    this.before = before;
    this.after = after;
    this.at = at;
  }
}
class ChangedPlan extends Error {}
async function stateIn(
  tx: DbSession,
  entities: string[],
  requestId: string,
  after?: State,
): Promise<State> {
  const ids = JSON.stringify(entities),
    filter = sql`in(select jsonb_array_elements_text(${ids}::jsonb)::uuid)`;
  const rows = await tx.execute<{ state: State }>(sql`select jsonb_build_object(
    'entities',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from lab.entities x where x.id ${filter}),
    'bindings',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from lab.runtime_bindings x where x.entity_id ${filter}),
    'generation',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from lab.runtime_generation x),
    'runs',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from(select * from lab.program_runs where entity_id ${filter} order by id limit 4097)x),
    'commands',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from(select * from lab.device_commands where entity_id ${filter} order by id limit 4097)x),
    'receipts',(select coalesce(jsonb_agg(to_jsonb(x) order by x.command_id),'[]'::jsonb) from(select * from lab.command_receipts where entity_id ${filter} order by command_id limit 4097)x),
    'tasks',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from(select * from lab.device_tasks where entity_id ${filter} order by id limit 4097)x),
    'results',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from(select r.* from lab.device_task_results r join lab.device_tasks t on t.id=r.task_id where t.entity_id ${filter} order by r.id limit 4097)x),
    'observations',(select coalesce(jsonb_agg(to_jsonb(x) order by x.entity_id),'[]'::jsonb) from lab.current_observations x where x.entity_id ${filter}),
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from(select * from lab.observation_history where entity_id ${filter} and ${after ? sql`xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text` : sql`false`} order by id limit 257)x),
    'events',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from(select * from lab.device_events where entity_id ${filter} and ${after ? sql`xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text` : sql`false`} order by id limit 257)x),
    'audit',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) from(select * from labos_threejs_core.audit_events where request_id=${requestId} and ${after ? sql`xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text` : sql`false`} order by id limit 257)x)
  ) as state`);
  const state = rows.rows[0].state;
  if (
    Object.values(state).some((r) => r.length > 4096) ||
    ['history', 'events', 'audit'].some((k) => state[k].length > 256) ||
    Buffer.byteLength(encoded(state)) > 2 * 1024 * 1024
  )
    throw new Error('recording_plan_capacity');
  return state;
}
function changed(kind: string, before: State, after: State) {
  const previous = new Map(before[kind].map((row) => [key(kind, row), row]));
  return after[kind].filter(
    (row) => encoded(previous.get(key(kind, row))) !== encoded(row),
  );
}
function businessEvents(
  before: State,
  after: State,
  at: string,
): RecordingBusinessEvent[] {
  const result: RecordingBusinessEvent[] = [];
  for (const row of after.events) {
    const data = row.data as Row,
      kind = data.record_type as string,
      id = String(data.record_id);
    const table =
      kind === 'program' ? 'runs' : kind === 'command' ? 'commands' : 'tasks';
    const fact = after[table].find((r) => String(r.id) === id);
    if (!fact) throw new Error('recording_transition_without_fact');
    result.push({
      event_id: String(row.id),
      event_type:
        kind === 'program'
          ? 'program.changed'
          : kind === 'command'
            ? 'command.changed'
            : 'task.changed',
      entity_id: String(row.entity_id),
      recorded_at: utcInstant(String(row.received_at)),
      sim_time_ns: null,
      event: {
        [kind]: { ...fact, status: data.status },
        transition: data,
        ...(kind === 'program'
          ? {
              binding:
                after.bindings.find((r) => r.id === fact.binding_id) ?? null,
            }
          : {}),
        ...(kind === 'task'
          ? {
              result:
                after.results.find((r) => String(r.task_id) === id) ?? null,
            }
          : {}),
      },
    });
  }
  for (const row of after.history)
    result.push({
      event_id: String(row.id),
      event_type: 'observation.report',
      entity_id: String(row.entity_id),
      recorded_at: utcInstant(String(row.received_at)),
      sim_time_ns: null,
      event: {
        run_id: row.run_id,
        observed_at: row.observed_at,
        received_at: row.received_at,
        ...(row.data as Row),
      },
    });
  for (const row of changed('results', before, after)) {
    if (
      result.some(
        (event) =>
          event.event_type === 'task.changed' &&
          (event.event.task as Row).id === row.task_id,
      )
    )
      continue;
    const task = after.tasks.find((t) => t.id === row.task_id);
    if (task)
      result.push({
        event_id: randomUUID(),
        event_type: 'task.changed',
        entity_id: String(task.entity_id),
        recorded_at: at,
        sim_time_ns: null,
        event: { task, result: row },
      });
  }
  return result;
}
async function put(
  tx: DbSession,
  table: string,
  row: Row,
  insert: boolean,
  kind: string,
) {
  const name = table.split('.'),
    identity = kind === 'observations' ? 'entity_id' : 'id';
  if (insert) {
    await tx.execute(
      sql`insert into ${sql.identifier(name[0])}.${sql.identifier(name[1])} select x.* from jsonb_populate_record(null::${sql.identifier(name[0])}.${sql.identifier(name[1])},${encoded(row)}::jsonb)x`,
    );
    return;
  }
  const columns = Object.keys(row).filter((k) => k !== identity);
  await tx.execute(
    sql`update ${sql.identifier(name[0])}.${sql.identifier(name[1])} t set ${sql.join(
      columns.map((c) => sql`${sql.identifier(c)}=x.${sql.identifier(c)}`),
      sql`, `,
    )} from jsonb_populate_record(null::${sql.identifier(name[0])}.${sql.identifier(name[1])},${encoded(row)}::jsonb)x where t.${sql.identifier(identity)}=x.${sql.identifier(identity)}`,
  );
}
async function apply(tx: DbSession, before: State, after: State) {
  // Preserve the precise transition IDs/times produced by the planning transaction.
  await tx.execute(sql`select set_config('lab.recording_apply','on',true)`);
  for (const kind of [
    'runs',
    'commands',
    'tasks',
    'results',
    'observations',
  ] as const) {
    const previous = new Map(before[kind].map((row) => [key(kind, row), row]));
    for (const row of changed(kind, before, after)) {
      if (kind === 'commands' && !previous.has(key(kind, row)))
        await put(tx, tables[kind], { ...row, task_id: null }, true, kind);
      else
        await put(tx, tables[kind], row, !previous.has(key(kind, row)), kind);
    }
  }
  for (const row of changed('commands', before, after)) {
    if (!before.commands.some((r) => r.id === row.id) && row.task_id)
      await put(tx, tables.commands, row, false, 'commands');
  }
  for (const kind of ['history', 'events', 'audit'] as const)
    for (const row of after[kind]) await put(tx, tables[kind], row, true, kind);
}

/** Exact plans for the existing server-owned, DB-only virtual Device Programs. */
export class DeviceRecordingCapture implements RecordingCapture {
  private db: Database;
  private host: CaptureHost;
  constructor(db: Database, host: CaptureHost) {
    this.db = db;
    this.host = host;
  }
  hasActiveRecordings() {
    return this.host.hasActiveRecordings();
  }
  covers(entityId: string) {
    return this.host.covers(entityId);
  }
  async transaction<T>(
    operation: DbOperation,
    scope: RecordingCaptureScope,
    work: (tx: DbSession) => Promise<T>,
    validate?: (tx: DbSession) => Promise<unknown>,
  ): Promise<T> {
    if (!this.hasActiveRecordings())
      return this.db.transaction(operation, work);
    const resolved = await this.host.scope(operation, scope);
    if (!resolved) return this.db.transaction(operation, work);
    return this.host.gate([resolved.lab], async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let plan: PlannedRollback<T>;
        try {
          await this.db.transaction(operation, async (tx) => {
            const before = await stateIn(tx, resolved.entities, operation.id),
              at = utcInstant(
                (
                  await tx.execute<{ at: string }>(
                    sql`select now()::text as at`,
                  )
                ).rows[0].at,
              );
            const value = await work(tx),
              after = await stateIn(
                tx,
                resolved.entities,
                operation.id,
                before,
              );
            throw new PlannedRollback(value, before, after, at);
          });
          throw new Error('recording_plan_did_not_rollback');
        } catch (error) {
          if (!(error instanceof PlannedRollback)) throw error;
          plan = error as PlannedRollback<T>;
        }
        const events = businessEvents(plan.before, plan.after, plan.at);
        if (!events.length) {
          try {
            return await this.db.transaction(operation, async (tx) => {
              await validate?.(tx);
              const current = await stateIn(
                tx,
                resolved.entities,
                operation.id,
              );
              if (encoded(current) !== encoded(plan.before))
                throw new ChangedPlan();
              return work(tx);
            });
          } catch (error) {
            if (error instanceof ChangedPlan && attempt === 0) continue;
            throw error;
          }
        }
        const batches = await this.host.prepare(events);
        try {
          await this.db.transaction(operation, async (tx) => {
            await validate?.(tx);
            const current = await stateIn(tx, resolved.entities, operation.id);
            if (encoded(current) !== encoded(plan.before))
              throw new ChangedPlan();
            await apply(tx, plan.before, plan.after);
            await this.host.witness(tx, batches);
          });
        } catch (error) {
          await this.host.abort(batches);
          if (error instanceof ChangedPlan) {
            if (attempt === 0) continue;
            throw new Error('recording_mutation_conflict', { cause: error });
          }
          throw error;
        }
        try {
          await this.host.commit(batches);
        } catch (error) {
          this.host.failed(
            'recording_event_commit_failed',
            batches.map((b) => b.recording_id),
          );
          throw error;
        }
        return plan.value;
      }
      throw new Error('recording_mutation_conflict');
    });
  }
}
