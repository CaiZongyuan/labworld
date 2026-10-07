import { readFileSync } from 'node:fs';
import { accessIn } from '../../core/api-keys/authentication.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { sql } from '../../platform/db/index.ts';
import { loadLab } from '../world/use-cases.ts';
import { loadEntity, worldId } from '../world/entities.ts';
import { addSeconds, instantNanoseconds, microsecondCeiling } from '../time.ts';
import {
  queryRange,
  invalidHistory,
  type HistoryService,
} from '../history/use-cases.ts';
import { bindQuery } from '../history/query.ts';
const listSQL = readFileSync(new URL('./list.sql', import.meta.url), 'utf8'),
  coverageSQL = readFileSync(
    new URL('./coverage.sql', import.meta.url),
    'utf8',
  ),
  anchorSQL = readFileSync(new URL('./anchor.sql', import.meta.url), 'utf8');
type RecordItem = {
  id: string;
  record_type: string;
  recorded_at: string;
  ended_at: string | null;
  archived_at: string | null;
  [key: string]: unknown;
};
type Coverage = {
  record_type: string;
  captured_since: string | null;
  fully_captured_since: string | null;
  cleaned_before: string | null;
  oldest_record_at: string | null;
  newest_record_at: string | null;
};
type Cursor = {
  version: number;
  lab: string;
  entity: string | null;
  kind: string | null;
  from: string;
  to: string;
  queried_at: string;
  upper: string;
  time: string;
  record_type: string;
  id: string;
};
const kinds = ['command', 'task', 'event', 'run'];
export class RecordsService {
  readonly history: HistoryService;
  constructor(history: HistoryService) {
    this.history = history;
  }
  async list(
    headers: Headers,
    requestId: string,
    labInput: string,
    q: {
      from: string;
      to: string;
      entity_id?: string;
      record_type?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    const { context, auth, policy } = this.history;
    return context.db.operation(
      { id: requestId, kind: 'request', budget: 10 },
      () =>
        context.db.transaction(
          { id: requestId, kind: 'request' },
          async (tx) => {
            await accessIn(tx, context, auth, headers, 'lab:full');
            const lab = worldId(labInput),
              entity = q.entity_id === undefined ? null : worldId(q.entity_id),
              kind = q.record_type ?? null,
              range = queryRange(q.from, q.to),
              limit = Number(q.limit ?? 20),
              now = utcInstant(
                (
                  await tx.execute<{ now: string }>(
                    sql`select clock_timestamp() as now`,
                  )
                ).rows[0].now,
              );
            if (
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 100 ||
              (kind !== null && !kinds.includes(kind))
            )
              invalidHistory();
            let cursor: Cursor | undefined;
            if (q.cursor !== undefined) {
              try {
                if (
                  q.cursor.length > 2048 ||
                  !/^[A-Za-z0-9_-]+$/.test(q.cursor)
                )
                  invalidHistory();
                cursor = JSON.parse(
                  Buffer.from(q.cursor, 'base64url').toString(),
                ) as Cursor;
                if (
                  !cursor ||
                  Object.keys(cursor).length !== 11 ||
                  cursor.version !== 1 ||
                  cursor.lab !== lab ||
                  cursor.entity !== entity ||
                  cursor.kind !== kind ||
                  instantNanoseconds(cursor.from) !== range.start ||
                  instantNanoseconds(cursor.to) !== range.end ||
                  instantNanoseconds(cursor.queried_at) >
                    instantNanoseconds(now) ||
                  instantNanoseconds(cursor.upper) !==
                    (instantNanoseconds(cursor.to) <
                    instantNanoseconds(cursor.queried_at)
                      ? instantNanoseconds(cursor.to)
                      : instantNanoseconds(cursor.queried_at)) ||
                  instantNanoseconds(cursor.time) < range.start ||
                  instantNanoseconds(cursor.time) >=
                    instantNanoseconds(cursor.upper) ||
                  instantNanoseconds(cursor.time) % 1000n !== 0n ||
                  !kinds.includes(cursor.record_type) ||
                  (kind !== null && cursor.record_type !== kind)
                )
                  invalidHistory();
                worldId(cursor.id);
              } catch {
                invalidHistory();
              }
            }
            const queriedAt = cursor?.queried_at ?? now,
              upper =
                instantNanoseconds(q.to) < instantNanoseconds(queriedAt)
                  ? q.to
                  : queriedAt,
              from = microsecondCeiling(q.from),
              to = microsecondCeiling(upper),
              cutoff = addSeconds(queriedAt, -policy.record_seconds);
            await loadLab(tx, lab);
            if (entity) await loadEntity(tx, lab, entity);
            if (cursor) {
              const anchor = await tx.execute<{ exists: boolean }>(
                bindQuery(anchorSQL, [
                  lab,
                  entity,
                  cursor.record_type,
                  cursor.id,
                  cursor.time,
                ]),
              );
              if (!anchor.rows[0].exists) invalidHistory();
            }
            const rows = await tx.execute<RecordItem>(
              bindQuery(listSQL, [
                lab,
                from,
                to,
                limit + 1,
                entity,
                kind,
                cursor?.time ?? null,
                cursor?.record_type ?? null,
                cursor?.id ?? null,
                cutoff,
              ]),
            );
            const coverageRows = await tx.execute<Coverage>(
              bindQuery(coverageSQL, [lab, from, to, entity, kind, cutoff]),
            );
            const coverage = coverageRows.rows.map((raw) => {
              const row = { ...raw };
              for (const key of [
                'captured_since',
                'fully_captured_since',
                'cleaned_before',
                'oldest_record_at',
                'newest_record_at',
              ] as const)
                if (row[key]) row[key] = utcInstant(row[key]);
              const retained =
                row.record_type === 'run'
                  ? null
                  : row.cleaned_before &&
                      instantNanoseconds(row.cleaned_before) >
                        instantNanoseconds(cutoff)
                    ? row.cleaned_before
                    : cutoff;
              const gaps: Array<{ from: string; to: string; reason: string }> =
                [];
              for (const [reason, start, end] of [
                ['capture', q.from, row.captured_since],
                [
                  'partial_capture',
                  row.captured_since,
                  row.fully_captured_since,
                ],
                ['retention', q.from, retained],
              ] as const)
                if (start && end) {
                  const lo =
                      instantNanoseconds(start) > range.start ? start : q.from,
                    hi =
                      instantNanoseconds(end) < instantNanoseconds(upper)
                        ? end
                        : upper;
                  if (instantNanoseconds(lo) < instantNanoseconds(hi))
                    gaps.push({ from: lo, to: hi, reason });
                }
              return {
                ...row,
                retention_seconds:
                  row.record_type === 'run' ? null : policy.record_seconds,
                preserves_unfinished:
                  row.record_type === 'command' || row.record_type === 'task',
                available_since: row.captured_since
                  ? retained &&
                    instantNanoseconds(retained) >
                      instantNanoseconds(row.captured_since)
                    ? retained
                    : row.captured_since
                  : null,
                gaps,
              };
            });
            const items: RecordItem[] = rows.rows.slice(0, limit).map((raw) => {
              const row = { ...raw, recorded_at: utcInstant(raw.recorded_at) };
              for (const key of ['ended_at', 'archived_at'] as const)
                if (row[key]) row[key] = utcInstant(row[key]);
              return row;
            });
            const page = {
              from: q.from,
              to: q.to,
              queried_at: queriedAt,
              query_upper_bound: upper,
              entity_id: entity,
              record_type: kind,
              retention: policy,
              coverage,
              max_page_items: 100,
              max_range_seconds: 31 * 86400,
              max_response_bytes: 256 * 1024,
              items,
              next_cursor: null as string | null,
            };
            for (;;) {
              const last = items.at(-1);
              page.next_cursor =
                rows.rows.length > items.length && last
                  ? Buffer.from(
                      JSON.stringify({
                        version: 1,
                        lab,
                        entity,
                        kind,
                        from: q.from,
                        to: q.to,
                        queried_at: queriedAt,
                        upper,
                        time: last.recorded_at,
                        record_type: last.record_type,
                        id: last.id,
                      }),
                    ).toString('base64url')
                  : null;
              if (
                Buffer.byteLength(JSON.stringify(page)) <=
                page.max_response_bytes
              )
                break;
              if (items.length <= 1)
                throw new PublicFailure(
                  413,
                  'lab.records_too_large',
                  'A record exceeds the response budget',
                );
              items.pop();
            }
            return page;
          },
        ),
    );
  }
}
