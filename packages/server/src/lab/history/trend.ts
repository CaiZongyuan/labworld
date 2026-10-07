import { readFileSync } from 'node:fs';
import { sql } from '../../platform/db/index.ts';
import { accessIn } from '../../core/api-keys/authentication.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { utcInstant } from '../../platform/db/instant.ts';
import { loadEntity } from '../world/entities.ts';
import { addSeconds, instantNanoseconds } from '../time.ts';
import { bindQuery } from './query.ts';
import {
  invalidHistory,
  queryRange,
  type HistoryService,
} from './use-cases.ts';
const query = readFileSync(new URL('./trend.sql', import.meta.url), 'utf8');
type TrendRead = {
  raw_sample_count: number;
  returned_sample_count: number;
  plot_item_count: number;
  budget_exceeded: boolean;
  first_report_at: string | null;
  last_report_at: string | null;
  segments: Array<{
    binding_id: string;
    run_id: string;
    source: string;
    quality: string;
    unit: string | null;
    source_time_known: boolean;
    resolution_seconds: number;
    samples: Array<{
      id: string;
      value: number;
      sequence: number;
      observed_at: string | null;
      received_at: string;
      expires_at: string;
    }>;
  }>;
  gaps: Array<{ from: string; to: string; reasons: string[] }>;
};
function clock(value: string) {
  const ns = instantNanoseconds(value),
    nanos = ((ns % 1000000000n) + 1000000000n) % 1000000000n;
  return {
    seconds: Number((ns - nanos) / 1000000000n),
    nanos: Number(nanos),
    value,
  };
}
export async function entityTrend(
  history: HistoryService,
  headers: Headers,
  requestId: string,
  lab: string,
  id: string,
  q: { property: string; from: string; to: string; max_points?: string },
) {
  const { context, auth, policy } = history;
  return context.db.operation(
    { id: requestId, kind: 'request', budget: 10 },
    () =>
      context.db.transaction({ id: requestId, kind: 'request' }, async (tx) => {
        await accessIn(tx, context, auth, headers, 'lab:full');
        queryRange(q.from, q.to, 86400);
        const points = Number(q.max_points ?? 600);
        if (
          !Number.isSafeInteger(points) ||
          points < 1 ||
          points > 1000 ||
          !['temperature', 'speed'].includes(q.property)
        )
          invalidHistory();
        const device = await loadEntity(tx, lab, id),
          state = device.definition.state as {
            properties?: Record<string, { type?: string }>;
          } | null;
        if (state?.properties?.[q.property]?.type !== 'number') {
          const numeric = await tx.execute<{ exists: boolean }>(
            sql`select exists(select 1 from lab.runtime_bindings where entity_id=${device.id}::uuid and definition->'state'->'properties'->${q.property}->>'type'='number')`,
          );
          if (!numeric.rows[0].exists) invalidHistory();
        }
        const bounds = await tx.execute<{
          captured_since: string;
          cleaned_before: string | null;
        }>(
          sql`select captured_since,cleaned_before from lab.history_bounds where entity_id=${device.id}::uuid and record_type='observation'`,
        );
        const captured = utcInstant(bounds.rows[0].captured_since),
          cutoff = addSeconds(context.clock.now(), -policy.observation_seconds),
          cleaned = bounds.rows[0].cleaned_before
            ? utcInstant(bounds.rows[0].cleaned_before)
            : cutoff,
          retained =
            instantNanoseconds(cleaned) > instantNanoseconds(cutoff)
              ? cleaned
              : cutoff;
        const clocks = {
          from: clock(q.from),
          to: clock(q.to),
          retained: clock(retained),
          captured: clock(captured),
        };
        const result = await tx.execute<{ value: TrendRead }>(
          bindQuery(
            'select result.value from (' + query + ') as result(value)',
            [
              device.id,
              q.property,
              q.from,
              q.to,
              points,
              retained,
              captured,
              JSON.stringify(clocks),
            ],
            [
              'uuid',
              'text',
              'timestamptz',
              'timestamptz',
              'bigint',
              'timestamptz',
              'timestamptz',
              'jsonb',
            ],
          ),
        );
        const read = result.rows[0].value;
        if (read.budget_exceeded)
          throw new PublicFailure(
            413,
            'lab.trend_budget_exceeded',
            'Trend cannot preserve samples and gaps within the requested budget',
          );
        const response = {
          property: q.property,
          from: q.from,
          to: q.to,
          max_points: points,
          raw_sample_count: read.raw_sample_count,
          returned_sample_count: read.returned_sample_count,
          plot_item_count: read.plot_item_count,
          sampling_strategy: 'first_last_min_max',
          segments: read.segments,
          gaps: read.gaps,
          first_report_at: read.first_report_at,
          last_report_at: read.last_report_at,
          retained_since: retained,
          captured_since: captured,
          available_since:
            instantNanoseconds(retained) > instantNanoseconds(captured)
              ? retained
              : captured,
          observation_retention_seconds: policy.observation_seconds,
          max_response_bytes: 256 * 1024,
          max_range_seconds: 86400,
        };
        if (
          Buffer.byteLength(JSON.stringify(response)) >
          response.max_response_bytes
        )
          throw new PublicFailure(
            413,
            'lab.trend_budget_exceeded',
            'Trend exceeds response byte budget',
          );
        return response;
      }),
  );
}
