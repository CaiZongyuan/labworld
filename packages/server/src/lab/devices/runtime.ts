import { randomUUID } from 'node:crypto';
import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import {
  object,
  type ObservationProperty,
  type ObservationReport,
} from './domain.ts';
type Source = {
  entity_id: string;
  run_id: string;
  binding_id: string;
  source: string;
  program_id: string;
  sequence: number;
  configuration: Record<string, unknown>;
};
type State = {
  values: Record<string, unknown>;
  properties: Record<string, ObservationProperty>;
  observed_times: Record<string, string>;
};
export class DeviceRuntime {
  readonly context: FoundationContext;
  readonly log: (event: Record<string, unknown>) => void;
  generation = 0;
  ready = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<void>;
  private reports = new Set<Promise<unknown>>();
  constructor(
    context: FoundationContext,
    log: (event: Record<string, unknown>) => void = () => {},
  ) {
    this.context = context;
    this.log = log;
  }
  async initialize() {
    const generation = await this.context.db.transaction(
      { id: 'devices:recover:' + randomUUID(), kind: 'startup' },
      async (tx) => {
        const result = await tx.execute<{ generation: number }>(
          sql`update lab.runtime_generation set generation=generation+1 where singleton returning generation`,
        );
        const unfinished = await tx.execute<{
          run: boolean;
          task: boolean;
          command: boolean;
        }>(
          sql`select exists(select 1 from lab.program_runs where status='running') as run,exists(select 1 from lab.device_tasks where status in('pending','preparing','running','decelerating')) as task,exists(select 1 from lab.device_commands where status in('accepted','executing')) as command`,
        );
        if (unfinished.rows[0].run)
          await tx.execute(
            sql`update lab.program_runs set status='interrupted',ended_at=now() where status='running'`,
          );
        if (unfinished.rows[0].task) {
          await tx.execute(
            sql`update lab.device_task_results set status='interrupted',reason='runtime_interrupted',ended_at=now() where task_id in(select id from lab.device_tasks where status in('pending','preparing','running','decelerating'))`,
          );
          await tx.execute(
            sql`update lab.device_tasks set status='interrupted',ended_at=now() where status in('pending','preparing','running','decelerating')`,
          );
        }
        if (unfinished.rows[0].command)
          await tx.execute(
            sql`update lab.device_commands set status='unknown',result=jsonb_build_object('reason','runtime_interrupted'),updated_at=now() where status in('accepted','executing')`,
          );
        return Number(result.rows[0].generation);
      },
    );
    this.generation = generation;
    this.ready = !this.stopped;
  }
  start() {
    if (!this.ready || this.timer || this.stopped) return;
    const loop = async () => {
      await this.tick();
      if (!this.stopped) {
        this.timer = setTimeout(() => void loop(), 100);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => void loop(), 100);
    this.timer.unref();
  }
  async tick() {
    if (this.stopped || !this.ready) return;
    if (this.current) return this.current;
    const id = 'devices:tick:' + randomUUID();
    this.current = this.context.db
      .operation({ id, kind: 'background' }, async () => {
        await this.processNext(id);
        await this.expire(id);
      })
      .catch((error) => {
        this.log({
          event: 'devices.tick_failed',
          message:
            error instanceof Error ? error.message : 'Device tick failed',
        });
      });
    try {
      await this.current;
    } finally {
      this.current = undefined;
    }
  }
  async stop() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.timer);
    await this.current;
    await Promise.allSettled([...this.reports]);
  }
  private async sourceIn(tx: DbSession, run: string) {
    const rows = await tx.execute<Source>(
      sql`select r.entity_id::text,r.id::text as run_id,r.binding_id::text,b.source,b.program_id,r.sequence,r.configuration from lab.program_runs r join lab.runtime_bindings b on b.id=r.binding_id and b.entity_id=r.entity_id and b.current join lab.runtime_generation g on g.singleton and g.generation=r.generation where r.id=${run}::uuid and r.status='running' and r.generation=${this.generation}`,
    );
    return rows.rows[0];
  }
  /** Trusted device ingress; this capability deliberately has no Member/Agent HTTP route. */
  async report(binding: string, run: string, report: ObservationReport) {
    if (this.stopped || !this.ready) return 'stale_run';
    const id = 'devices:report:' + randomUUID();
    const admitted = this.context.db.operation({ id, kind: 'background' }, () =>
      this.context.db.transaction({ id, kind: 'background' }, async (tx) => {
        const source = await this.sourceIn(tx, run);
        if (!source || source.binding_id !== binding) return 'stale_run';
        if (report.sequence <= Number(source.sequence)) return 'out_of_order';
        return (await this.observeIn(
          tx,
          source,
          report,
          this.context.clock.now(),
        ))
          ? 'applied'
          : 'out_of_order';
      }),
    );
    this.reports.add(admitted);
    try {
      return await admitted;
    } finally {
      this.reports.delete(admitted);
    }
  }
  private async processNext(id: string) {
    const command = await this.context.db.transaction(
      { id, kind: 'background' },
      async (tx) => {
        const rows = await tx.execute<{ id: string; run_id: string }>(
          sql`select c.id::text,c.run_id::text from lab.device_commands c join lab.program_runs r on r.id=c.run_id join lab.runtime_generation g on g.singleton and g.generation=r.generation where c.status='accepted' and r.status='running' and r.generation=${this.generation} order by c.created_at,c.id limit 1`,
        );
        if (!rows.rows[0]) return undefined;
        await tx.execute(
          sql`update lab.device_commands set status='executing',updated_at=now() where id=${rows.rows[0].id}::uuid`,
        );
        return rows.rows[0];
      },
    );
    if (!command) return;
    try {
      await this.context.db.transaction(
        { id, kind: 'background' },
        async (tx) => {
          const source = await this.sourceIn(tx, command.run_id);
          if (!source) return;
          const actions = await tx.execute<{
            capability: string;
            parameters: Record<string, unknown>;
          }>(
            sql`select capability,parameters from lab.device_commands where id=${command.id}::uuid and status='executing'`,
          );
          if (!actions.rows[0]) return;
          const previous = await tx.execute<{
            values: Record<string, unknown>;
          }>(
            sql`select values from lab.current_observations where entity_id=${source.entity_id}::uuid and run_id=${source.run_id}::uuid`,
          );
          const values = previous.rows[0]?.values ?? {
            on: source.configuration.on ?? false,
            brightness: source.configuration.brightness ?? 100,
          };
          const { capability, parameters } = actions.rows[0];
          if (capability === 'light.set_power') values.on = parameters.on;
          else if (capability === 'light.set_brightness')
            values.brightness = parameters.brightness;
          else throw new Error('Unsupported device capability');
          const now = this.context.clock.now(),
            sequence = Number(source.sequence) + 1;
          if (
            !(await this.observeIn(
              tx,
              source,
              { sequence, values, observed_at: now, quality: 'good' },
              now,
            ))
          )
            throw new Error('Device report would regress source time');
          await tx.execute(
            sql`update lab.device_commands set status='succeeded',result=${JSON.stringify({ meaning: 'applied_by_device_program', observation_sequence: sequence, values })}::jsonb,updated_at=now() where id=${command.id}::uuid`,
          );
        },
      );
    } catch (error) {
      await this.context.db.transaction(
        { id, kind: 'background' },
        async (tx) => {
          await tx.execute(
            sql`update lab.device_commands set status='unknown',result=jsonb_build_object('reason','execution_uncertain'),updated_at=now() where id=${command.id}::uuid and status='executing'`,
          );
        },
      );
      throw error;
    }
  }
  private async observeIn(
    tx: DbSession,
    source: Source,
    report: ObservationReport,
    now: string,
  ) {
    if (
      !Number.isSafeInteger(report.sequence) ||
      report.sequence < 1 ||
      !['good', 'uncertain', 'bad'].includes(report.quality) ||
      !object(report.values) ||
      !Object.entries(report.values).every(
        ([name, value]) =>
          source.program_id === 'light.v1' &&
          ((name === 'on' && typeof value === 'boolean') ||
            (name === 'brightness' &&
              typeof value === 'number' &&
              Number.isFinite(value) &&
              value >= 0 &&
              value <= 100)),
      )
    )
      throw new Error('Invalid device observation');
    const existing = await tx.execute<State>(
      sql`select values,properties,observed_times from lab.current_observations where entity_id=${source.entity_id}::uuid`,
    );
    const state = existing.rows[0] ?? {
      values: {},
      properties: {},
      observed_times: {},
    };
    for (const name of Object.keys(report.values))
      if (
        state.properties[name]?.run_id === source.run_id &&
        state.observed_times[name] &&
        report.observed_at &&
        Date.parse(report.observed_at) < Date.parse(state.observed_times[name])
      )
        return false;
    const properties: Record<string, ObservationProperty> = {};
    for (const [name, value] of Object.entries(report.values)) {
      if (state.properties[name]?.run_id !== source.run_id)
        delete state.observed_times[name];
      if (report.observed_at) state.observed_times[name] = report.observed_at;
      properties[name] = {
        value,
        unit: name === 'brightness' ? '%' : null,
        binding_id: source.binding_id,
        run_id: source.run_id,
        sequence: report.sequence,
        source: source.source,
        observed_at: report.observed_at,
        received_at: now,
        updated_at: now,
        expires_at: new Date(Date.parse(now) + 5000).toISOString(),
        quality: report.quality,
        freshness: report.observed_at ? 'current' : 'source_time_unknown',
      };
      state.values[name] = value;
      state.properties[name] = properties[name];
    }
    await tx.execute(
      sql`insert into lab.observation_history(entity_id,run_id,observed_at,received_at,data) values(${source.entity_id}::uuid,${source.run_id}::uuid,${report.observed_at}::timestamptz,${now}::timestamptz,${JSON.stringify({ source: source.source, binding_id: source.binding_id, sequence: report.sequence, values: report.values, properties, quality: report.quality })}::jsonb)`,
    );
    await tx.execute(
      sql`update lab.program_runs set sequence=${report.sequence} where id=${source.run_id}::uuid`,
    );
    if (Object.keys(report.values).length === 0) return true;
    const freshness = Object.values(state.properties).some(
      (property) => property.freshness === 'stale',
    )
      ? 'stale'
      : Object.values(state.properties).some(
            (property) => property.freshness === 'source_time_unknown',
          )
        ? 'source_time_unknown'
        : 'current';
    await tx.execute(
      sql`insert into lab.current_observations(entity_id,run_id,sequence,source,values,observed_at,received_at,updated_at,quality,properties,observed_times,freshness) values(${source.entity_id}::uuid,${source.run_id}::uuid,${report.sequence},${source.source},${JSON.stringify(state.values)}::jsonb,${report.observed_at}::timestamptz,${now}::timestamptz,${now}::timestamptz,${report.quality},${JSON.stringify(state.properties)}::jsonb,${JSON.stringify(state.observed_times)}::jsonb,${freshness}) on conflict(entity_id) do update set run_id=excluded.run_id,sequence=excluded.sequence,source=excluded.source,values=excluded.values,observed_at=excluded.observed_at,received_at=excluded.received_at,updated_at=excluded.updated_at,quality=excluded.quality,properties=excluded.properties,observed_times=excluded.observed_times,freshness=excluded.freshness`,
    );
    return true;
  }
  private async expire(id: string) {
    const now = this.context.clock.now();
    await this.context.db.transaction(
      { id, kind: 'background' },
      async (tx) => {
        const rows = await tx.execute<{
          entity_id: string;
          properties: Record<string, ObservationProperty>;
        }>(
          sql`select o.entity_id::text,o.properties from lab.current_observations o join lab.runtime_generation g on g.singleton and g.generation=${this.generation} where exists(select 1 from jsonb_each(o.properties) p where p.value->>'freshness'<>'stale' and (p.value->>'expires_at')::timestamptz<=${now}::timestamptz)`,
        );
        for (const row of rows.rows) {
          for (const property of Object.values(row.properties))
            if (Date.parse(property.expires_at) <= Date.parse(now))
              property.freshness = 'stale';
          await tx.execute(
            sql`update lab.current_observations set properties=${JSON.stringify(row.properties)}::jsonb,freshness='stale' where entity_id=${row.entity_id}::uuid`,
          );
        }
      },
    );
  }
}
