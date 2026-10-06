import { randomUUID } from 'node:crypto';
import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { addSeconds, instantNanoseconds } from '../time.ts';
import {
  object,
  validObservation,
  advanceCentrifuge,
  type CentrifugeTask,
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
        await this.sampleDue(id);
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
        const now = this.context.clock.now();
        if (!(await this.observeIn(tx, source, report, now)))
          return 'out_of_order';
        if (
          source.program_id === 'centrifuge.v1' &&
          report.quality !== 'good' &&
          Object.keys(report.values).length
        )
          await this.failTaskIn(
            tx,
            source,
            report.quality === 'bad' ? 'failed' : 'unknown',
            report.quality === 'bad' ? 'device_fault' : 'observation_uncertain',
            now,
          );
        return 'applied';
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
          if (source.program_id === 'centrifuge.v1') {
            await this.executeCentrifuge(
              tx,
              source,
              command.id,
              actions.rows[0].capability,
              this.context.clock.now(),
            );
            return;
          }
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
          const source = await this.sourceIn(tx, command.run_id);
          if (source?.program_id === 'centrifuge.v1')
            await this.failTaskIn(
              tx,
              source,
              'unknown',
              'execution_uncertain',
              this.context.clock.now(),
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
      !validObservation(source.program_id, report.values)
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
        instantNanoseconds(report.observed_at) <
          instantNanoseconds(state.observed_times[name])
      )
        return false;
    const properties: Record<string, ObservationProperty> = {};
    for (const [name, value] of Object.entries(report.values)) {
      if (state.properties[name]?.run_id !== source.run_id)
        delete state.observed_times[name];
      if (report.observed_at) state.observed_times[name] = report.observed_at;
      properties[name] = {
        value,
        unit:
          name === 'brightness'
            ? '%'
            : name === 'temperature'
              ? 'degC'
              : name === 'speed'
                ? 'rpm'
                : name === 'elapsed_seconds'
                  ? 's'
                  : null,
        binding_id: source.binding_id,
        run_id: source.run_id,
        sequence: report.sequence,
        source: source.source,
        observed_at: report.observed_at,
        received_at: now,
        updated_at: now,
        expires_at: addSeconds(now, 5),
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
  private async sampleDue(id: string) {
    const now = this.context.clock.now();
    await this.context.db.transaction(
      { id, kind: 'background' },
      async (tx) => {
        const due = await tx.execute<{ id: string }>(
          sql`select r.id::text from lab.program_runs r join lab.runtime_bindings b on b.id=r.binding_id and b.current join lab.runtime_generation g on g.singleton and g.generation=r.generation where r.status='running' and r.generation=${this.generation} and b.program_id in('sensor.v1','centrifuge.v1') and (r.next_sample_at is null or r.next_sample_at<=${now}::timestamptz) order by r.id`,
        );
        for (const run of due.rows) {
          const source = await this.sourceIn(tx, run.id);
          if (!source) continue;
          if (source.program_id === 'centrifuge.v1') {
            await this.sampleCentrifuge(tx, source, now);
            await tx.execute(
              sql`update lab.program_runs set next_sample_at=${addSeconds(now, 1)}::timestamptz where id=${source.run_id}::uuid`,
            );
            continue;
          }
          const sequence = Number(source.sequence) + 1,
            baseline = Number(source.configuration.baseline_temperature ?? 22);
          const values = {
            temperature:
              Math.round((baseline + Math.sin(sequence * 0.2) * 0.5) * 10) / 10,
          };
          if (
            !(await this.observeIn(
              tx,
              source,
              { sequence, values, observed_at: now, quality: 'good' },
              now,
            ))
          )
            continue;
          await tx.execute(
            sql`update lab.program_runs set next_sample_at=${addSeconds(now, 1)}::timestamptz where id=${source.run_id}::uuid`,
          );
        }
      },
    );
  }

  private async valuesIn(tx: DbSession, source: Source) {
    const result = await tx.execute<{ values: Record<string, unknown> }>(
      sql`select values from lab.current_observations where entity_id=${source.entity_id}::uuid and run_id=${source.run_id}::uuid`,
    );
    return (
      result.rows[0]?.values ?? {
        speed: 0,
        temperature: source.configuration.initial_temperature ?? 22,
        phase: 'idle',
        elapsed_seconds: 0,
      }
    );
  }
  private async taskIn(tx: DbSession, source: Source) {
    const rows = await tx.execute<CentrifugeTask>(
      sql`select id::text,result_id::text,parameters,status,elapsed_seconds,last_tick_at,pending_outcome from lab.device_tasks where run_id=${source.run_id}::uuid and status in('pending','preparing','running','decelerating')`,
    );
    return rows.rows[0];
  }
  private async failTaskIn(
    tx: DbSession,
    source: Source,
    outcome: string,
    reason: string,
    now: string,
  ) {
    const task = await this.taskIn(tx, source);
    if (!task) return;
    await tx.execute(
      sql`update lab.device_task_results set reason=${reason} where id=${task.result_id}::uuid`,
    );
    await tx.execute(
      sql`update lab.device_tasks set status='decelerating',pending_outcome=${outcome},last_tick_at=case when status='decelerating' then last_tick_at else ${now}::timestamptz end where id=${task.id}::uuid`,
    );
  }
  private async executeCentrifuge(
    tx: DbSession,
    source: Source,
    command: string,
    capability: string,
    now: string,
  ) {
    const commands = await tx.execute<{ task_id: string | null }>(
        sql`select task_id::text from lab.device_commands where id=${command}::uuid`,
      ),
      taskId = commands.rows[0].task_id;
    if (capability === 'centrifuge.start') {
      if (!taskId) throw new Error('Missing reserved Task');
      await tx.execute(
        sql`update lab.device_tasks set status='preparing',last_tick_at=${now}::timestamptz where id=${taskId}::uuid`,
      );
      const previous = await this.valuesIn(tx, source);
      if (
        !(await this.observeIn(
          tx,
          source,
          {
            sequence: Number(source.sequence) + 1,
            values: {
              speed: 0,
              temperature: previous.temperature,
              phase: 'preparing',
              elapsed_seconds: 0,
            },
            observed_at: now,
            quality: 'good',
          },
          now,
        ))
      )
        throw new Error('Device report would regress source time');
    } else if (capability === 'centrifuge.stop' && taskId) {
      const task = await this.taskIn(tx, source);
      if (task) {
        const elapsed =
          task.status === 'running'
            ? Math.min(
                task.parameters.duration_seconds,
                task.elapsed_seconds +
                  Math.max(
                    0,
                    (Date.parse(now) - Date.parse(task.last_tick_at!)) / 1000,
                  ),
              )
            : task.elapsed_seconds;
        const outcome =
          task.pending_outcome === 'failed' ||
          task.pending_outcome === 'unknown'
            ? task.pending_outcome
            : 'cancelled';
        await tx.execute(
          sql`update lab.device_tasks set status='decelerating',pending_outcome=${outcome},elapsed_seconds=${elapsed},last_tick_at=case when status='decelerating' then last_tick_at else ${now}::timestamptz end where id=${task.id}::uuid`,
        );
        if (
          !(await this.observeIn(
            tx,
            source,
            {
              sequence: Number(source.sequence) + 1,
              values: { phase: 'decelerating', elapsed_seconds: elapsed },
              observed_at: now,
              quality: 'good',
            },
            now,
          ))
        )
          throw new Error('Device report would regress source time');
      }
    }
    await tx.execute(
      sql`update lab.device_commands set status='succeeded',result=${JSON.stringify({ meaning: capability === 'centrifuge.start' ? 'task_started' : 'deceleration_requested', task_id: taskId })}::jsonb,updated_at=${now}::timestamptz where id=${command}::uuid`,
    );
  }
  private async sampleCentrifuge(tx: DbSession, source: Source, now: string) {
    let values = await this.valuesIn(tx, source);
    const task = await this.taskIn(tx, source);
    if (task && task.status !== 'pending') {
      const next = advanceCentrifuge(task, values, now);
      await tx.execute(
        sql`update lab.device_tasks set status=${next.status},elapsed_seconds=${next.elapsed},last_tick_at=${now}::timestamptz,pending_outcome=${next.outcome},timer_started_at=case when ${next.timerStarted} then ${now}::timestamptz else timer_started_at end,ended_at=case when ${next.terminal} then ${now}::timestamptz else ended_at end where id=${task.id}::uuid`,
      );
      if (next.terminal)
        await tx.execute(
          sql`update lab.device_task_results set status=${next.status},reason=coalesce(reason,${next.status === 'unknown' ? 'execution_uncertain' : null}),ended_at=${now}::timestamptz where id=${task.result_id}::uuid`,
        );
      values = next.values;
    }
    if (
      !(await this.observeIn(
        tx,
        source,
        {
          sequence: Number(source.sequence) + 1,
          values,
          observed_at: now,
          quality: 'good',
        },
        now,
      ))
    )
      throw new Error('Device report would regress source time');
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
          let changed = false;
          for (const property of Object.values(row.properties))
            if (
              property.freshness !== 'stale' &&
              instantNanoseconds(property.expires_at) <= instantNanoseconds(now)
            ) {
              property.freshness = 'stale';
              changed = true;
            }
          if (!changed) continue;
          await tx.execute(
            sql`update lab.current_observations set properties=${JSON.stringify(row.properties)}::jsonb,freshness='stale' where entity_id=${row.entity_id}::uuid`,
          );
        }
      },
    );
  }
}
