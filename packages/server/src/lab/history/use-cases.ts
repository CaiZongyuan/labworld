import { randomUUID } from 'node:crypto';
import { sql, type DbSession } from '../../platform/db/index.ts';
import type { FoundationContext } from '../../platform/context.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import { databaseAudit } from '../../core/audit/use-cases.ts';
import { fingerprint } from '../../core/idempotency/use-cases.ts';
import type { AuthPolicy } from '../../core/identity/domain.ts';
import { loadEntity, worldId } from '../world/entities.ts';
import { loadLab } from '../world/use-cases.ts';
import { addSeconds, instantNanoseconds, microsecondCeiling } from '../time.ts';
import {
  defaultRetention,
  historyKinds,
  type RetentionPolicy,
  type HistoryKind,
  type HistoryRecord,
} from './domain.ts';
const maxBytes = 256 * 1024,
  maxRange = 31 * 86400;
export function invalidHistory(): never {
  throw new PublicFailure(
    400,
    'lab.invalid_input',
    'Use a valid bounded history query',
  );
}
function cursorValue(value: string) {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      invalidHistory();
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    ) as Record<string, string>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      ['entity', 'kind', 'from', 'to', 'time', 'id'].some(
        (key) => typeof cursor[key] !== 'string',
      )
    )
      invalidHistory();
    instantNanoseconds(cursor.time);
    return cursor;
  } catch {
    invalidHistory();
  }
}
export function queryRange(from: string, to: string, maximum = maxRange) {
  try {
    const start = instantNanoseconds(from),
      end = instantNanoseconds(to);
    if (start >= end || end - start > BigInt(maximum) * 1000000000n)
      invalidHistory();
    return { start, end };
  } catch {
    invalidHistory();
  }
}
export class HistoryService {
  readonly context: FoundationContext;
  readonly auth: AuthPolicy;
  readonly policy: RetentionPolicy;
  constructor(
    context: FoundationContext,
    auth: AuthPolicy,
    policy: RetentionPolicy = defaultRetention,
  ) {
    this.context = context;
    this.auth = auth;
    this.policy = policy;
  }
  async retention(headers: Headers, requestId: string, lab: string) {
    return this.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(tx, this.context, this.auth, headers, 'lab:full');
        await loadLab(tx, lab);
        return this.policy;
      },
    );
  }
  async list(
    headers: Headers,
    requestId: string,
    lab: string,
    id: string,
    query: {
      record_type: string;
      from: string;
      to: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        await accessIn(tx, this.context, this.auth, headers, 'lab:full');
        const entity = worldId(id),
          kind = query.record_type as HistoryKind,
          limit = Number(query.limit ?? 20),
          range = queryRange(query.from, query.to);
        if (
          !historyKinds.includes(kind) ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          invalidHistory();
        const cursor =
          query.cursor === undefined ? undefined : cursorValue(query.cursor);
        if (
          cursor &&
          (cursor.entity !== entity ||
            cursor.kind !== kind ||
            cursor.from !== range.start.toString() ||
            cursor.to !== range.end.toString() ||
            instantNanoseconds(cursor.time) < range.start ||
            instantNanoseconds(cursor.time) >= range.end)
        )
          invalidHistory();
        if (cursor) worldId(cursor.id);
        await loadEntity(tx, lab, entity);
        const bounds = await tx.execute<{
          captured_since: string;
          cleaned_before: string | null;
        }>(
          sql`select captured_since,cleaned_before from lab.history_bounds where entity_id=${entity}::uuid and record_type=${kind}`,
        );
        const cutoff = addSeconds(
            this.context.clock.now(),
            -(kind === 'observation'
              ? this.policy.observation_seconds
              : this.policy.record_seconds),
          ),
          captured = utcInstant(bounds.rows[0].captured_since),
          cleaned = bounds.rows[0].cleaned_before
            ? utcInstant(bounds.rows[0].cleaned_before)
            : cutoff;
        const retained =
            instantNanoseconds(cleaned) > instantNanoseconds(cutoff)
              ? cleaned
              : cutoff,
          available =
            instantNanoseconds(captured) > instantNanoseconds(retained)
              ? captured
              : retained;
        const table =
            kind === 'observation'
              ? 'lab.observation_history'
              : kind === 'command'
                ? 'lab.device_commands'
                : kind === 'task'
                  ? 'lab.device_tasks'
                  : 'lab.device_events',
          time = sql.raw(
            kind === 'command' || kind === 'task'
              ? 'h.created_at'
              : 'h.received_at',
          );
        const columns =
          kind === 'observation'
            ? sql`h.observed_at,h.received_at,h.data`
            : kind === 'command'
              ? sql`null::timestamptz as observed_at,h.created_at as received_at,to_jsonb(h) as data`
              : kind === 'task'
                ? sql`null::timestamptz as observed_at,h.created_at as received_at,(to_jsonb(h)-'last_tick_at'-'pending_outcome')||jsonb_build_object('result',(select to_jsonb(r) from lab.device_task_results r where r.id=h.result_id)) as data`
                : sql`h.occurred_at as observed_at,h.received_at,h.data`;
        const unfinished =
          kind === 'command'
            ? sql`h.status in('accepted','executing') or h.updated_at>=${retained}::timestamptz or exists(select 1 from lab.device_tasks t where t.command_id=h.id and t.ended_at is null)`
            : kind === 'task'
              ? sql`h.ended_at is null or h.ended_at>=${retained}::timestamptz`
              : sql`false`;
        const rows = await tx.execute<HistoryRecord>(
          sql`select h.id::text,h.entity_id::text,h.run_id::text,${time} as recorded_at,${columns} from ${sql.raw(table)} h where h.entity_id=${entity}::uuid and ${time}>=${microsecondCeiling(query.from)}::timestamptz and ${time}<${microsecondCeiling(query.to)}::timestamptz and ${cursor ? sql`(${time},h.id)<(${cursor.time}::timestamptz,${cursor.id}::uuid)` : sql`true`} and (${time}>=${retained}::timestamptz or (${unfinished})) order by ${time} desc,h.id desc limit ${limit + 1}`,
        );
        const items: HistoryRecord[] = [];
        let bytes = 0;
        for (const row of rows.rows.slice(0, limit)) {
          const item = {
            ...row,
            recorded_at: utcInstant(row.recorded_at),
            received_at: utcInstant(row.received_at),
            observed_at: row.observed_at ? utcInstant(row.observed_at) : null,
          };
          bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (bytes >= maxBytes - 4096) break;
          items.push(item);
        }
        if (rows.rows.length && !items.length)
          throw new PublicFailure(
            413,
            'lab.snapshot_too_large',
            'History record exceeds response limit',
          );
        const last = items.at(-1),
          next =
            rows.rows.length > items.length && last
              ? Buffer.from(
                  JSON.stringify({
                    entity,
                    kind,
                    from: range.start.toString(),
                    to: range.end.toString(),
                    time: last.recorded_at,
                    id: last.id,
                  }),
                ).toString('base64url')
              : null;
        return {
          record_type: kind,
          from: query.from,
          to: query.to,
          available_since: available,
          gap: range.start < instantNanoseconds(available),
          retention: this.policy,
          max_range_seconds: maxRange,
          max_response_bytes: maxBytes,
          items,
          next_cursor: next,
        };
      },
    );
  }
  async cleanup(headers: Headers, requestId: string, lab: string) {
    return this.context.db.transaction(
      { id: requestId, kind: 'request' },
      async (tx) => {
        const actor = await accessIn(
          tx,
          this.context,
          this.auth,
          headers,
          'lab:full',
          true,
        );
        await loadLab(tx, lab);
        const result = await this.cleanupIn(
          tx,
          worldId(lab),
          this.context.clock.now(),
        );
        await databaseAudit.record(tx, {
          actorId: actor.user.id,
          actorType: actor.isApiKey ? 'agent' : 'user',
          action: 'lab.history.cleanup',
          resourceType: 'lab.lab',
          resourceId: lab,
          requestId,
          correlationId: requestId,
          metadata: {},
        });
        return result;
      },
    );
  }
  async cleanupIn(tx: DbSession, lab: string, now: string) {
    const observationCutoff = addSeconds(now, -this.policy.observation_seconds),
      recordCutoff = addSeconds(now, -this.policy.record_seconds),
      counts = { observations: 0, tasks: 0, commands: 0, events: 0 };
    const selections = [
      [
        'observations',
        'lab.observation_history',
        sql`select h.id::text from lab.observation_history h join lab.entities e on e.id=h.entity_id where e.lab_id=${lab}::uuid and h.received_at<${observationCutoff}::timestamptz order by h.received_at,h.id limit 10000`,
      ],
      [
        'tasks',
        'lab.device_tasks',
        sql`select t.id::text from lab.device_tasks t join lab.entities e on e.id=t.entity_id where e.lab_id=${lab}::uuid and t.ended_at<${recordCutoff}::timestamptz order by t.ended_at,t.id limit 10000`,
      ],
      [
        'commands',
        'lab.device_commands',
        sql`select c.id::text from lab.device_commands c join lab.entities e on e.id=c.entity_id where e.lab_id=${lab}::uuid and c.status in('succeeded','failed','unknown') and c.updated_at<${recordCutoff}::timestamptz and not exists(select 1 from lab.device_tasks t where t.command_id=c.id and t.ended_at is null) order by c.updated_at,c.id limit 10000`,
      ],
      [
        'events',
        'lab.device_events',
        sql`select h.id::text from lab.device_events h join lab.entities e on e.id=h.entity_id where e.lab_id=${lab}::uuid and h.received_at<${recordCutoff}::timestamptz order by h.received_at,h.id limit 10000`,
      ],
    ] as const;
    for (const [kind, table, selection] of selections) {
      const ids = (await tx.execute<{ id: string }>(selection)).rows.map(
        (row) => row.id,
      );
      if (!ids.length) continue;
      const match = sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`,`,
      );
      if (kind === 'commands') {
        const commands = await tx.execute<{
          actor_id: string;
          entity_id: string;
          request_key: string;
          id: string;
          capability: string;
          parameters: unknown;
        }>(
          sql`select actor_id::text,entity_id::text,request_key,id::text,capability,parameters from lab.device_commands where id in(${match})`,
        );
        const receipts = commands.rows.map((command) => ({
          actor_id: command.actor_id,
          entity_id: command.entity_id,
          request_key: command.request_key,
          command_id: command.id,
          fingerprint: fingerprint({
            capability: command.capability,
            parameters: command.parameters,
          }).toString('hex'),
        }));
        await tx.execute(
          sql`insert into lab.command_receipts(actor_id,entity_id,request_key,command_id,fingerprint) select r.actor_id::uuid,r.entity_id::uuid,r.request_key,r.command_id::uuid,r.fingerprint from jsonb_to_recordset(${JSON.stringify(receipts)}::jsonb) as r(actor_id text,entity_id text,request_key text,command_id text,fingerprint text) on conflict(actor_id,entity_id,request_key) do nothing`,
        );
      }
      const removed = await tx.execute<{ id: string }>(
        sql`delete from ${sql.raw(table)} where id in(${match}) returning id`,
      );
      counts[kind] = removed.rows.length;
    }
    await tx.execute(
      sql`update lab.history_bounds h set cleaned_before=greatest(coalesce(cleaned_before,'-infinity'::timestamptz),case when record_type='observation' then ${observationCutoff}::timestamptz else ${recordCutoff}::timestamptz end) from lab.entities e where e.id=h.entity_id and e.lab_id=${lab}::uuid`,
    );
    return {
      ...counts,
      more: Object.values(counts).includes(10000),
      observation_cutoff: observationCutoff,
      record_cutoff: recordCutoff,
    };
  }
  async maintain() {
    const id = 'history:maintenance:' + randomUUID();
    return this.context.db.operation({ id, kind: 'background' }, () =>
      this.context.db.transaction({ id, kind: 'background' }, async (tx) => {
        const labs = await tx.execute<{ id: string }>(
          sql`select id::text from lab.labs order by id`,
        );
        for (const lab of labs.rows)
          await this.cleanupIn(tx, lab.id, this.context.clock.now());
      }),
    );
  }
}
