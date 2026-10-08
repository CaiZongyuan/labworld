import type { FoundationContext } from '../../platform/context.ts';
import { sql, type DbSession } from '../../platform/db/index.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { AuthPolicy } from '../../core/identity/domain.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import {
  guideId,
  guideVersion,
  guideProgressLimits,
  type GuideProgress,
  type GuideContext,
  type SaveProgress,
} from './domain.ts';

const columns = sql`guide_id,guide_version,revision,status,step,guide_attempt_id::text,context,updated_at`;
function progress(row: GuideProgress): GuideProgress {
  return {
    ...row,
    revision: Number(row.revision),
    updated_at: row.updated_at === null ? null : utcInstant(row.updated_at),
  };
}
async function load(tx: DbSession, actor: string, id: string, version: string) {
  const result = await tx.execute<GuideProgress>(
    sql`select ${columns} from lab.guide_progress where actor_id=${actor}::uuid and guide_id=${id} and guide_version=${version}`,
  );
  return result.rows[0] ? progress(result.rows[0]) : null;
}
function checkGuide(id: string, version: string, write: boolean) {
  if (id !== guideId)
    throw new PublicFailure(404, 'lab.guide_not_found', 'Guide not found');
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(version))
    throw new PublicFailure(
      400,
      'lab.invalid_input',
      'Provide a guide version',
    );
  if (write && version !== guideVersion)
    throw new PublicFailure(
      400,
      'lab.guide_version_unsupported',
      'Start the current guide version explicitly',
    );
}
function failed(error: unknown): never {
  if (error instanceof PublicFailure) throw error;
  throw new PublicFailure(
    503,
    'lab.unavailable',
    'Lab is temporarily unavailable',
  );
}
function reply<T>(value: T, limit: number): T {
  if (Buffer.byteLength(JSON.stringify(value)) > limit)
    throw new PublicFailure(
      503,
      'lab.unavailable',
      'Guide progress exceeds its response budget',
    );
  return value;
}
async function validateContext(
  tx: DbSession,
  context: GuideContext | null,
  previous: GuideContext | null,
) {
  if (!context) return;
  const attempt = context.business_attempt;
  if (
    (attempt?.operation === 'create_lab' && attempt.target_lab_id !== null) ||
    (attempt?.operation === 'register_entity' &&
      (attempt.target_lab_id === null ||
        attempt.target_lab_id !== context.lab_id)) ||
    (context.lab_id === null &&
      (context.entity_id !== null || context.node_id !== null))
  )
    throw new PublicFailure(
      400,
      'lab.invalid_reference',
      'Use matching Lab, Entity, Node and attempt references',
    );
  if (
    previous &&
    previous.lab_id === context.lab_id &&
    previous.entity_id === context.entity_id &&
    previous.node_id === context.node_id
  )
    return;
  if (context.lab_id === null) return;
  const result = await tx.execute<{
    valid: boolean;
  }>(sql`select exists(select 1 from lab.labs where id=${context.lab_id}::uuid)
    and (${context.entity_id}::uuid is null or exists(select 1 from lab.entities where lab_id=${context.lab_id}::uuid and id=${context.entity_id}::uuid))
    and (${context.node_id}::uuid is null or exists(select 1 from lab.scene_nodes where lab_id=${context.lab_id}::uuid and id=${context.node_id}::uuid and (${context.entity_id}::uuid is null or entity_id=${context.entity_id}::uuid))) as valid`);
  if (!result.rows[0]?.valid)
    throw new PublicFailure(
      400,
      'lab.invalid_reference',
      'Use references belonging to this Lab',
    );
}
export class ProgressService {
  private context: FoundationContext;
  private policy: AuthPolicy;
  constructor(context: FoundationContext, policy: AuthPolicy) {
    this.context = context;
    this.policy = policy;
  }
  async get(headers: Headers, requestId: string, id: string, version: string) {
    try {
      return await this.context.db.transaction(
        {
          id: requestId,
          kind: 'request',
          budget: guideProgressLimits.readSqlStatements,
        },
        async (tx) => {
          const actor = await accessIn(
            tx,
            this.context,
            this.policy,
            headers,
            'lab:full',
          );
          checkGuide(id, version, false);
          const stored = await load(tx, actor.user.id, id, version);
          let previous: GuideProgress | null = null;
          if (
            version === guideVersion &&
            (!stored || stored.status === 'not_started')
          ) {
            const rows = await tx.execute<GuideProgress>(
              sql`select ${columns} from lab.guide_progress where actor_id=${actor.user.id}::uuid and guide_id=${id} and guide_version<>${version} order by updated_at desc,guide_version desc limit 1`,
            );
            if (rows.rows[0]) previous = progress(rows.rows[0]);
          }
          return reply(
            {
              current_guide_version: guideVersion,
              compatibility:
                version !== guideVersion
                  ? ('unsupported' as const)
                  : previous
                    ? ('restart_required' as const)
                    : ('compatible' as const),
              progress: stored ?? {
                guide_id: id,
                guide_version: version,
                revision: 0,
                status: 'not_started' as const,
                step: null,
                guide_attempt_id: null,
                context: null,
                updated_at: null,
              },
              previous_progress: previous,
            },
            guideProgressLimits.readBytes,
          );
        },
      );
    } catch (error) {
      failed(error);
    }
  }
  async save(
    headers: Headers,
    requestId: string,
    id: string,
    version: string,
    input: SaveProgress,
  ) {
    input = {
      ...input,
      guide_attempt_id: input.guide_attempt_id?.toLowerCase() ?? null,
      context:
        input.context === null
          ? null
          : {
              ...input.context,
              lab_id: input.context.lab_id?.toLowerCase() ?? null,
              entity_id: input.context.entity_id?.toLowerCase() ?? null,
              node_id: input.context.node_id?.toLowerCase() ?? null,
              business_attempt:
                input.context.business_attempt === null
                  ? null
                  : {
                      ...input.context.business_attempt,
                      target_lab_id:
                        input.context.business_attempt.target_lab_id?.toLowerCase() ??
                        null,
                    },
            },
    };
    try {
      return await this.context.db.transaction(
        {
          id: requestId,
          kind: 'request',
          budget: guideProgressLimits.saveSqlStatements,
        },
        async (tx) => {
          const actor = await accessIn(
            tx,
            this.context,
            this.policy,
            headers,
            'lab:full',
            true,
          );
          checkGuide(id, version, true);
          if (
            Buffer.byteLength(JSON.stringify(input.context)) >
            guideProgressLimits.contextBytes
          )
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Guide context exceeds its byte budget',
            );
          const active =
            input.status === 'in_progress' || input.status === 'paused';
          if (
            !Number.isSafeInteger(input.expected_revision) ||
            input.expected_revision < 0 ||
            input.expected_revision >= Number.MAX_SAFE_INTEGER ||
            (input.status === 'not_started' &&
              (input.step !== null ||
                input.guide_attempt_id !== null ||
                input.context !== null)) ||
            (active &&
              (input.step === null ||
                input.step === 'complete' ||
                input.guide_attempt_id === null)) ||
            (input.status === 'completed' &&
              (input.step !== 'complete' || input.guide_attempt_id === null))
          )
            throw new PublicFailure(
              400,
              'lab.invalid_input',
              'Use a valid guide state and revision',
            );
          const old = await load(tx, actor.user.id, id, version);
          if ((old?.revision ?? 0) !== input.expected_revision)
            throw new PublicFailure(
              409,
              'lab.guide_progress_conflict',
              'Reload progress before explicitly retrying the save',
            );
          await validateContext(tx, input.context, old?.context ?? null);
          const result = await tx.execute<GuideProgress>(
            sql`insert into lab.guide_progress as old(actor_id,guide_id,guide_version,revision,status,step,guide_attempt_id,context,updated_at) values(${actor.user.id}::uuid,${id},${version},1,${input.status},${input.step},${input.guide_attempt_id}::uuid,${input.context === null ? null : JSON.stringify(input.context)}::jsonb,${this.context.clock.now()}::timestamptz) on conflict(actor_id,guide_id,guide_version) do update set revision=old.revision+1,status=excluded.status,step=excluded.step,guide_attempt_id=excluded.guide_attempt_id,context=excluded.context,updated_at=${this.context.clock.now()}::timestamptz where old.revision=${input.expected_revision} returning ${columns}`,
          );
          if (!result.rows[0])
            throw new PublicFailure(
              409,
              'lab.guide_progress_conflict',
              'Reload progress before explicitly retrying the save',
            );
          await databaseAudit.record(tx, {
            actorId: actor.user.id,
            actorType: actor.isApiKey ? 'agent' : 'user',
            action: 'lab.guide_progress.save',
            resourceType: 'lab.guide_progress',
            resourceId: `${actor.user.id}/${id}/${version}`,
            requestId,
            correlationId: requestId,
            metadata: {},
          });
          return reply(progress(result.rows[0]), guideProgressLimits.saveBytes);
        },
      );
    } catch (error) {
      failed(error);
    }
  }
}
