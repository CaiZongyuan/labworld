import { randomUUID } from 'node:crypto';
import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import type { AuthPolicy } from '../../core/identity/domain.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import { fingerprint } from '../../core/idempotency/use-cases.ts';
import { loadEntity, worldId } from '../world/entities.ts';
import type { RecordingCapture } from '../recordings/capture.ts';
import {
  activeTask,
  validProgramConfiguration,
  validParameters,
  type DeviceCommand,
} from './domain.ts';

export const commandColumns = sql`c.id::text,c.entity_id::text,c.run_id::text,c.actor_id::text,c.actor_source,c.request_key,c.capability,c.parameters,c.status,c.result,c.task_id::text,c.created_at,c.updated_at`;
export function commandValue(row: DeviceCommand): DeviceCommand {
  return {
    ...row,
    created_at: utcInstant(row.created_at),
    updated_at: utcInstant(row.updated_at),
  };
}
export function deviceFailure(
  status: ConstructorParameters<typeof PublicFailure>[0],
  code: string,
  message: string,
): never {
  throw new PublicFailure(status, code, message);
}
export class DeviceService {
  readonly context: FoundationContext;
  readonly policy: AuthPolicy;
  readonly runtime: { generation: number; ready: boolean };
  readonly capture?: RecordingCapture;
  constructor(
    context: FoundationContext,
    policy: AuthPolicy,
    runtime: { generation: number; ready: boolean },
    capture?: RecordingCapture,
  ) {
    this.context = context;
    this.policy = policy;
    this.runtime = runtime;
    this.capture = capture;
  }
  private available() {
    if (!this.runtime.ready)
      deviceFailure(
        503,
        'lab.runtime_unavailable',
        'Device runtime is not initialized; no command was accepted',
      );
  }
  async start(headers: Headers, requestId: string, lab: string, id: string) {
    return this.mutate(headers, requestId, lab, id, async (tx) => {
      const actor = await accessIn(
        tx,
        this.context,
        this.policy,
        headers,
        'lab:full',
        true,
      );
      this.available();
      const entity = await loadEntity(tx, lab, id);
      if (entity.archived_at)
        deviceFailure(409, 'lab.entity_archived', 'This Entity is archived');
      if (!entity.binding)
        deviceFailure(
          422,
          'lab.capability_not_implemented',
          'This Entity has no Binding implementing this program',
        );
      if (entity.program_run?.status === 'running')
        return { value: entity.program_run, created: false };
      if (
        !validProgramConfiguration(
          entity.binding.program_id,
          entity.configuration,
        )
      )
        deviceFailure(
          422,
          'lab.invalid_parameters',
          'Use the program input types and allowed range',
        );
      // Entity projections break tied storage timestamps by Run ID. Use
      // the platform's ordered UUID generator for this creation order.
      const inserted = await tx.execute<{ id: string }>(
        sql`insert into lab.program_runs(id,entity_id,binding_id,generation,configuration,status,started_by) values(uuidv7(),${entity.id}::uuid,${entity.binding.id}::uuid,${this.runtime.generation},${JSON.stringify(entity.configuration)}::jsonb,'running',${actor.user.id}::uuid) returning id::text`,
      );
      const run = inserted.rows[0].id;
      await this.audit(
        tx,
        actor.user.id,
        actor.isApiKey,
        requestId,
        'lab.program.start',
        run,
      );
      return {
        value: (await loadEntity(tx, lab, id)).program_run!,
        created: true,
      };
    });
  }
  async stop(headers: Headers, requestId: string, lab: string, id: string) {
    return this.mutate(headers, requestId, lab, id, async (tx) => {
      const actor = await accessIn(
        tx,
        this.context,
        this.policy,
        headers,
        'lab:full',
        true,
      );
      const entity = await loadEntity(tx, lab, id);
      if (activeTask(entity.task))
        deviceFailure(
          409,
          'lab.device_busy',
          'Finish the current task before stopping the program',
        );
      if (!entity.program_run)
        deviceFailure(
          422,
          'lab.program_not_running',
          'Start the device program explicitly',
        );
      if (entity.program_run.status === 'running') {
        await tx.execute(
          sql`update lab.program_runs set status='stopped',ended_at=${this.context.clock.now()}::timestamptz where id=${entity.program_run.id}::uuid`,
        );
        await tx.execute(
          sql`update lab.device_commands set status=case when status='executing' then 'unknown' else 'failed' end,result=jsonb_build_object('reason','program_stopped'),updated_at=now() where run_id=${entity.program_run.id}::uuid and status in('accepted','executing')`,
        );
        await this.audit(
          tx,
          actor.user.id,
          actor.isApiKey,
          requestId,
          'lab.program.stop',
          String(entity.program_run.id),
        );
      }
      return (await loadEntity(tx, lab, id)).program_run!;
    });
  }
  async accept(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    input: { capability: string; parameters: unknown },
    integerParameters = true,
  ) {
    return this.mutate(headers, requestId, lab, id, async (tx) => {
      const actor = await accessIn(
        tx,
        this.context,
        this.policy,
        headers,
        'lab:full',
        true,
      );
      const entity = await loadEntity(tx, lab, id),
        key = headers.get('idempotency-key') ?? '';
      const previous = await tx.execute<DeviceCommand & { same: boolean }>(
        sql`select ${commandColumns},c.capability=${input.capability} and c.parameters=${JSON.stringify(input.parameters)}::jsonb as same from lab.device_commands c where c.actor_id=${actor.user.id}::uuid and c.entity_id=${entity.id}::uuid and c.request_key=${key}`,
      );
      if (previous.rows[0]) {
        const { same, ...command } = previous.rows[0];
        if (!same)
          deviceFailure(
            409,
            'idempotency.conflict',
            'This key was used with different parameters',
          );
        return commandValue(command);
      }
      const receipt = await tx.execute<{ fingerprint: string }>(
        sql`select fingerprint from lab.command_receipts where actor_id=${actor.user.id}::uuid and entity_id=${entity.id}::uuid and request_key=${key}`,
      );
      if (receipt.rows[0]) {
        const same =
          receipt.rows[0].fingerprint === fingerprint(input).toString('hex');
        deviceFailure(
          same ? 410 : 409,
          same ? 'lab.command_expired' : 'idempotency.conflict',
          'The original Command expired; this request was not executed again',
        );
      }
      if (entity.archived_at)
        deviceFailure(409, 'lab.entity_archived', 'This Entity is archived');
      this.available();
      const capability = entity.capabilities.find(
        (entry) => entry.id === input.capability,
      );
      if (!capability)
        deviceFailure(
          400,
          'lab.invalid_input',
          'Use a capability in this definition',
        );
      if (!capability.binding_implemented)
        deviceFailure(
          422,
          'lab.capability_not_implemented',
          'The Binding does not implement this capability',
        );
      if (!/^[\x21-\x7e]{1,128}$/.test(key))
        deviceFailure(
          400,
          'idempotency.invalid_key',
          'Provide an Idempotency-Key with 1–128 visible ASCII characters',
        );
      if (entity.program_run?.status !== 'running')
        deviceFailure(
          422,
          'lab.program_not_running',
          'Start the device program explicitly before sending a command',
        );
      if (
        !integerParameters ||
        !validParameters(input.capability, input.parameters)
      )
        deviceFailure(
          422,
          'lab.invalid_parameters',
          'Use the capability input types and allowed range',
        );
      if (input.capability === 'centrifuge.start' && activeTask(entity.task))
        deviceFailure(
          409,
          'lab.device_busy',
          'Finish the current task before starting another',
        );
      const insertedCommand = await tx.execute<{ id: string }>(
        sql`insert into lab.device_commands(id,entity_id,run_id,actor_id,actor_source,request_key,capability,parameters,status) values(uuidv7(),${entity.id}::uuid,${entity.program_run.id}::uuid,${actor.user.id}::uuid,${actor.isApiKey ? 'agent' : 'member'},${key},${input.capability},${JSON.stringify(input.parameters)}::jsonb,'accepted') returning id::text`,
      );
      const command = insertedCommand.rows[0].id;
      let task: string | null = null;
      if (input.capability === 'centrifuge.start') {
        const result = randomUUID();
        const insertedTask = await tx.execute<{ id: string }>(
          sql`insert into lab.device_tasks(id,entity_id,run_id,command_id,result_id,parameters,status) values(uuidv7(),${entity.id}::uuid,${entity.program_run.id}::uuid,${command}::uuid,${result}::uuid,${JSON.stringify(input.parameters)}::jsonb,'pending') returning id::text`,
        );
        task = insertedTask.rows[0].id;
        await tx.execute(
          sql`insert into lab.device_task_results(id,task_id,status) values(${result}::uuid,${task}::uuid,'pending')`,
        );
      } else if (
        input.capability === 'centrifuge.stop' &&
        activeTask(entity.task)
      )
        task = String(entity.task!.id);
      if (task)
        await tx.execute(
          sql`update lab.device_commands set task_id=${task}::uuid where id=${command}::uuid`,
        );
      await this.audit(
        tx,
        actor.user.id,
        actor.isApiKey,
        requestId,
        'lab.command.accept',
        command,
      );
      return this.commandIn(tx, lab, id, command);
    });
  }
  async commandIn(tx: DbSession, lab: string, entity: string, command: string) {
    const rows = await tx.execute<DeviceCommand>(
      sql`select ${commandColumns} from lab.device_commands c join lab.entities e on e.id=c.entity_id where e.lab_id=${worldId(lab)}::uuid and e.id=${worldId(entity)}::uuid and c.id=${worldId(command)}::uuid`,
    );
    if (!rows.rows[0])
      deviceFailure(
        404,
        'lab.world_not_found',
        'Lab, Entity or Command not found',
      );
    return commandValue(rows.rows[0]);
  }
  private mutate<T>(
    headers: Headers,
    requestId: string,
    lab: string,
    entity: string,
    work: (tx: DbSession) => Promise<T>,
  ) {
    const operation = { id: requestId, kind: 'request' as const };
    if (!this.capture) return this.context.db.transaction(operation, work);
    return this.capture.transaction(operation, { lab, entity }, work, (tx) =>
      accessIn(tx, this.context, this.policy, headers, 'lab:full', true),
    );
  }
  async command(
    headers: Headers,
    requestId: string,
    lab: string,
    entity: string,
    command: string,
  ) {
    return this.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(tx, this.context, this.policy, headers, 'lab:full');
        return this.commandIn(tx, lab, entity, command);
      },
    );
  }
  async record(
    headers: Headers,
    requestId: string,
    lab: string,
    entity: string,
    id: string,
    kind: 'runs' | 'tasks' | 'results',
  ) {
    return this.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(tx, this.context, this.policy, headers, 'lab:full');
        await loadEntity(tx, lab, entity);
        const selection =
          kind === 'runs'
            ? sql`select (to_jsonb(r)-'generation'-'sequence'-'last_observed_at'-'next_sample_at')||jsonb_build_object('program_id',b.program_id,'source',b.source,'definition_id',b.definition_id,'definition_version',b.definition_version,'definition',b.definition) as value from lab.program_runs r join lab.runtime_bindings b on b.id=r.binding_id where r.entity_id=${worldId(entity)}::uuid and r.id=${worldId(id)}::uuid`
            : kind === 'tasks'
              ? sql`select to_jsonb(t)-'last_tick_at'-'pending_outcome' as value from lab.device_tasks t where t.entity_id=${worldId(entity)}::uuid and t.id=${worldId(id)}::uuid`
              : sql`select to_jsonb(r) as value from lab.device_task_results r join lab.device_tasks t on t.result_id=r.id where t.entity_id=${worldId(entity)}::uuid and r.id=${worldId(id)}::uuid`;
        const rows = await tx.execute<{ value: Record<string, unknown> }>(
          selection,
        );
        if (!rows.rows[0])
          deviceFailure(
            404,
            'lab.world_not_found',
            'Lab, Entity or record not found',
          );
        const value = rows.rows[0].value;
        for (const field of [
          'started_at',
          'ended_at',
          'created_at',
          'timer_started_at',
        ])
          if (typeof value[field] === 'string')
            value[field] = utcInstant(value[field]);
        return value;
      },
    );
  }
  private audit(
    tx: DbSession,
    actorId: string,
    agent: boolean,
    requestId: string,
    action: string,
    resourceId: string,
  ) {
    return databaseAudit.record(tx, {
      actorId,
      actorType: agent ? 'agent' : 'user',
      action,
      resourceType: 'lab.device',
      resourceId,
      requestId,
      correlationId: requestId,
      metadata: {},
    });
  }
}
