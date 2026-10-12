import { randomUUID } from 'node:crypto';
import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import type { Session } from '../sessions/dto.ts';
import { catalog } from '../world/catalog.ts';
import { addSeconds } from '../time.ts';
import type { RecordingCapture } from '../recordings/capture.ts';
import type {
  RecordingIdentity,
  RobotIdentity,
  RobotCommand,
  RobotSourceEvent,
} from '../../../../contracts/src/recording/index.ts';

/** The admitted source owns execution. This adapter only projects its durable receipts. */
export class RobotControls {
  readonly context: FoundationContext;
  readonly capture: RecordingCapture;
  constructor(context: FoundationContext, capture: RecordingCapture) {
    this.context = context;
    this.capture = capture;
  }
  async bind(session: Session, recording: string): Promise<RobotIdentity> {
    const entity = session.snapshot.installation.targets.find(
      (t) => t.object_key === 'so101',
    )?.entity_id;
    if (!entity || session.snapshot.physics?.control_mode !== 'controlled')
      throw new Error('robot_scope_mismatch');
    return this.capture.transaction(
      { id: 'robot:bind:' + randomUUID(), kind: 'background' },
      { entity },
      async (tx) => {
        const exists = await tx.execute<RobotIdentity>(
          sql`select entity_id::text,binding_id::text,run_id::text from lab.session_device_runs where session_id=${session.id}::uuid`,
        );
        if (exists.rows[0]) return exists.rows[0];
        const binding = randomUUID(),
          run = randomUUID();
        const definition = catalog.find(
          (d) => d.id === 'robot' && d.version === '1.1',
        )!;
        await tx.execute(
          sql`update lab.runtime_bindings set current=false where entity_id=${entity}::uuid and current`,
        );
        await tx.execute(
          sql`insert into lab.runtime_bindings(id,entity_id,program_id,source,definition_id,definition_version,definition) values(${binding}::uuid,${entity}::uuid,'newton.so101.v1',${'simulated:newton:' + session.id},'robot',${definition.version},${JSON.stringify(definition)}::jsonb)`,
        );
        await tx.execute(
          sql`insert into lab.program_runs(id,entity_id,binding_id,generation,configuration,status,started_by) select ${run}::uuid,${entity}::uuid,${binding}::uuid,g.generation,${JSON.stringify({ session_id: session.id, recording_id: recording, epoch: session.epoch })}::jsonb,'running',s.started_by from lab.runtime_generation g,lab.simulation_sessions s where g.singleton and s.id=${session.id}::uuid and s.ended_at is null`,
        );
        await tx.execute(
          sql`insert into lab.session_device_runs(session_id,entity_id,binding_id,run_id,recording_id) values(${session.id}::uuid,${entity}::uuid,${binding}::uuid,${run}::uuid,${recording}::uuid)`,
        );
        return { entity_id: entity, binding_id: binding, run_id: run };
      },
    );
  }
  async end(session: Session, captured: boolean) {
    if (session.snapshot.physics?.control_mode !== 'controlled') return;
    const operation = {
      id: 'robot:end:' + randomUUID(),
      kind: 'background' as const,
    };
    const rows = await this.context.db.read(operation, (tx) =>
      tx.execute<RobotIdentity>(
        sql`select entity_id::text,binding_id::text,run_id::text from lab.session_device_runs where session_id=${session.id}::uuid`,
      ),
    );
    for (const row of rows.rows) {
      const work = async (tx: DbSession) => {
        const now = this.context.clock.now(),
          status = 'interrupted';
        await tx.execute(
          sql`update lab.device_task_results set status=${status},reason=${session.reason ?? 'session_ended'},ended_at=${now}::timestamptz where status='pending' and task_id in(select id from lab.device_tasks where run_id=${row.run_id}::uuid and status in('pending','preparing','running','decelerating'))`,
        );
        await tx.execute(
          sql`update lab.device_tasks set status=${status},ended_at=${now}::timestamptz where run_id=${row.run_id}::uuid and status in('pending','preparing','running','decelerating')`,
        );
        await tx.execute(
          sql`update lab.device_commands set status='unknown',result=jsonb_build_object('reason',${session.reason ?? 'session_ended'}::text),updated_at=${now}::timestamptz where run_id=${row.run_id}::uuid and status in('accepted','executing')`,
        );
        await tx.execute(
          sql`update lab.program_runs set status=${session.status === 'interrupted' ? 'interrupted' : 'stopped'},ended_at=${now}::timestamptz where id=${row.run_id}::uuid and status='running'`,
        );
        await tx.execute(
          sql`update lab.runtime_bindings set current=false where id=${row.binding_id}::uuid`,
        );
      };
      if (captured)
        await this.capture.transaction(
          operation,
          { entity: row.entity_id },
          work,
        );
      else await this.context.db.transaction(operation, work);
    }
  }
  async commands(identity: RecordingIdentity): Promise<RobotCommand[]> {
    const result = await this.context.db.read(
      { id: 'robot:dispatch:' + randomUUID(), kind: 'background' },
      (tx) =>
        tx.execute<RobotCommand>(
          sql`select 'robot.command' as type,1 as version,${identity.recording_id} as recording_id,${identity.session_id} as session_id,${identity.lease_id} as lease_id,${identity.epoch} as epoch,m.entity_id::text,m.binding_id::text,m.run_id::text,c.id::text as command_id,c.task_id::text,c.capability,c.parameters from lab.session_device_runs m join lab.simulation_sessions s on s.id=m.session_id join lab.program_runs r on r.id=m.run_id join lab.device_commands c on c.run_id=m.run_id where m.session_id=${identity.session_id}::uuid and m.recording_id=${identity.recording_id}::uuid and s.lease_id=${identity.lease_id}::uuid and s.epoch=${identity.epoch}::numeric and s.status in('running','paused') and s.ended_at is null and r.status='running' and c.status='accepted' order by c.created_at,c.id limit 2`,
        ),
    );
    return result.rows;
  }
  async validate(session: string, event: RobotSourceEvent) {
    await this.context.db.read(
      { id: 'robot:validate:' + event.event_id, kind: 'background' },
      (tx) => this.scopeIn(tx, session, event),
    );
  }
  private async scopeIn(
    tx: DbSession,
    session: string,
    event: RobotSourceEvent,
  ) {
    const s = event.subject;
    const result = await tx.execute<{ source: string }>(
      sql`select b.source from lab.session_device_runs m join lab.runtime_bindings b on b.id=m.binding_id where m.session_id=${session}::uuid and m.entity_id=${s.entity_id}::uuid and m.binding_id=${s.binding_id}::uuid and m.run_id=${s.run_id}::uuid`,
    );
    if (!result.rows[0] || s.session_id !== session)
      throw new Error('robot_scope_mismatch');
    if (event.event_type === 'robot.task') {
      const command = await tx.execute<{ task_id: string | null }>(
        sql`select task_id::text from lab.device_commands where id=${event.event.command_id}::uuid and entity_id=${s.entity_id}::uuid and run_id=${s.run_id}::uuid and capability in('robot.home','robot.move_joints','robot.set_gripper','robot.cancel')`,
      );
      if (!command.rows[0] || command.rows[0].task_id !== event.event.task_id)
        throw new Error('robot_command_mismatch');
    }
    return result.rows[0].source;
  }
  async apply(session: string, recording: string, event: RobotSourceEvent) {
    await this.context.db.transaction(
      { id: 'robot:result:' + event.event_id, kind: 'background' },
      async (tx) => {
        const inserted = await tx.execute(
          sql`insert into lab.robot_source_events(recording_id,event_id,source_event_sequence) values(${recording}::uuid,${event.event_id}::uuid,${event.source_event_sequence}::numeric) on conflict(recording_id,event_id) do nothing returning event_id`,
        );
        if (!inserted.rows.length) {
          const duplicate = await tx.execute<{ sequence: string }>(
            sql`select source_event_sequence::text as sequence from lab.robot_source_events where recording_id=${recording}::uuid and event_id=${event.event_id}::uuid`,
          );
          if (duplicate.rows[0]?.sequence !== event.source_event_sequence)
            throw new Error('robot_altered_duplicate');
          return;
        }
        // A journal replay can outlive ordinary Command/Task retention. The
        // durable receipt is checked before loading those disposable rows.
        const source = await this.scopeIn(tx, session, event),
          s = event.subject,
          e = event.event;
        const now = this.context.clock.now();
        const sequence = Number(event.source_event_sequence);
        const values = {
          joints: e.joints,
          velocity: e.velocity,
          phase: e.phase,
          sim_time_ns: event.sim_time_ns,
        };
        const properties = Object.fromEntries(
          Object.entries(values).map(([name, value]) => [
            name,
            {
              value,
              unit:
                name === 'joints'
                  ? 'rad'
                  : name === 'velocity'
                    ? 'rad/s'
                    : null,
              binding_id: s.binding_id,
              run_id: s.run_id,
              sequence,
              source,
              observed_at: event.observed_at,
              received_at: now,
              updated_at: now,
              expires_at: addSeconds(now, 5),
              quality: 'good',
              freshness: event.observed_at ? 'current' : 'source_time_unknown',
            },
          ]),
        );
        await tx.execute(
          sql`insert into lab.observation_history(entity_id,run_id,observed_at,received_at,data) values(${s.entity_id}::uuid,${s.run_id}::uuid,${event.observed_at}::timestamptz,${now}::timestamptz,${JSON.stringify({ source, binding_id: s.binding_id, sequence, values, properties, quality: 'good', sim_time_ns: event.sim_time_ns })}::jsonb)`,
        );
        await tx.execute(
          sql`update lab.program_runs set sequence=greatest(sequence,${sequence}) where id=${s.run_id}::uuid`,
        );
        await tx.execute(
          sql`insert into lab.current_observations(entity_id,run_id,sequence,source,values,observed_at,received_at,updated_at,quality,properties,observed_times,freshness) values(${s.entity_id}::uuid,${s.run_id}::uuid,${sequence},${source},${JSON.stringify(values)}::jsonb,${event.observed_at}::timestamptz,${now}::timestamptz,${now}::timestamptz,'good',${JSON.stringify(properties)}::jsonb,'{}'::jsonb,${event.observed_at ? 'current' : 'source_time_unknown'}) on conflict(entity_id) do update set run_id=excluded.run_id,sequence=excluded.sequence,source=excluded.source,values=excluded.values,observed_at=excluded.observed_at,received_at=excluded.received_at,updated_at=excluded.updated_at,quality=excluded.quality,properties=excluded.properties,freshness=excluded.freshness where lab.current_observations.run_id<>excluded.run_id or lab.current_observations.sequence<excluded.sequence`,
        );
        if (event.event_type !== 'robot.task') return;
        const taskEvent = event.event;
        const command = await tx.execute<{ capability: string }>(
          sql`select capability from lab.device_commands where id=${taskEvent.command_id}::uuid`,
        );
        const terminal = ['completed', 'cancelled', 'failed'].includes(
          taskEvent.status,
        );
        await tx.execute(
          sql`update lab.device_commands set status=${terminal ? (taskEvent.status === 'failed' ? 'failed' : 'succeeded') : 'executing'},result=${JSON.stringify({ meaning: terminal ? 'physical_result' : 'source_acknowledged', status: taskEvent.status, phase: taskEvent.phase, reason: taskEvent.reason, sim_time_ns: event.sim_time_ns, joints: taskEvent.joints, velocity: taskEvent.velocity, event_id: event.event_id })}::jsonb,updated_at=${now}::timestamptz where id=${taskEvent.command_id}::uuid and (status in('accepted','executing') or (${terminal} and status='unknown'))`,
        );
        if (!taskEvent.task_id || command.rows[0].capability === 'robot.cancel')
          return;
        await tx.execute(
          sql`update lab.device_tasks set status=${taskEvent.status === 'cancel_requested' ? 'decelerating' : taskEvent.status},pending_outcome=${taskEvent.status === 'cancel_requested' ? 'cancelled' : null},ended_at=${terminal ? now : null}::timestamptz where id=${taskEvent.task_id}::uuid and (status in('pending','preparing','running','decelerating') or (${terminal} and status in('interrupted','unknown')))`,
        );
        if (terminal)
          await tx.execute(
            sql`update lab.device_task_results set status=${taskEvent.status},reason=${taskEvent.reason},ended_at=${now}::timestamptz where task_id=${taskEvent.task_id}::uuid and status in('pending','interrupted','unknown')`,
          );
      },
    );
  }
}
