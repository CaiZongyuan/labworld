import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '../../packages/server/src/platform/db/index.ts';
import { HistoryService } from '../../packages/server/src/lab/history/use-cases.ts';
import { entityTrend } from '../../packages/server/src/lab/history/trend.ts';
import {
  addSeconds,
  instantNanoseconds,
} from '../../packages/server/src/lab/time.ts';
import { deviceHttpFixture } from '../support/device-http.ts';
test(
  'internal.trend: a restored full day preserves true spike extrema and collection gaps with bounded database compression; default crop is independent',
  { timeout: 60000 },
  async () => {
    const f = await deviceHttpFixture();
    try {
      const entity = await f.register('sensor'),
        run = await f.start(entity.id),
        from = new Date(Date.now() + 1000).toISOString(),
        to = addSeconds(from, 86400);
      f.setTime(from);
      await f.runtime.report(run.binding_id, run.id, {
        sequence: 1,
        values: { temperature: 20 },
        observed_at: from,
        quality: 'good',
      });
      // Explicit internal historical fixture, derived from a real HTTP-owned identity and production report.
      // This restored-history proof is not reported as HTTP-only sampling evidence.
      await f.db.transaction(
        { id: 'restored-day-fixture', kind: 'startup' },
        async (tx) => {
          await tx.execute(
            sql`with seed as(select * from lab.observation_history where entity_id=${entity.id}::uuid limit 1),reports as(select seed.*,n,${from}::timestamptz+n*interval '1 second' as at,case n when 12345 then 500 when 45678 then -100 else 20 end as value from seed cross join generate_series(1,86399) n where n not between 50000 and 50019) insert into lab.observation_history(entity_id,run_id,observed_at,received_at,data) select entity_id,run_id,at-interval '2 seconds',at,data||jsonb_build_object('sequence',n+1,'values',jsonb_build_object('temperature',value),'properties',jsonb_build_object('temperature',(data->'properties'->'temperature')||jsonb_build_object('sequence',n+1,'value',value,'observed_at',at-interval '2 seconds','received_at',at,'expires_at',at+interval '5 seconds'))) from reports`,
          );
        },
      );
      f.setTime(addSeconds(to, 1));
      await f.client.json('POST', f.path(entity.id) + '/program/stop');
      const header = new Headers({ cookie: f.client.cookie! }),
        retained = new HistoryService(f.context, f.policy, {
          observation_seconds: 172800,
          record_seconds: 2592000,
        });
      const response = await entityTrend(
        retained,
        header,
        'restored-day-query',
        f.lab.id,
        entity.id,
        { property: 'temperature', from, to, max_points: '600' },
      );
      const samples = response.segments.flatMap((segment) => segment.samples);
      assert.equal(response.raw_sample_count, 86380);
      assert.ok(response.plot_item_count <= 600);
      assert.ok(response.returned_sample_count < response.raw_sample_count);
      assert.ok(samples.some((sample) => sample.value === 500));
      assert.ok(samples.some((sample) => sample.value === -100));
      assert.ok(
        response.gaps.some((gap) => gap.reasons.includes('collection_gap')),
      );
      assert.ok(samples.some((sample) => sample.sequence === 1));
      assert.ok(samples.some((sample) => sample.sequence === 86400));
      await assert.rejects(
        entityTrend(
          retained,
          header,
          'impossible-restored-budget',
          f.lab.id,
          entity.id,
          { property: 'temperature', from, to, max_points: '1' },
        ),
        (error: unknown) =>
          !!error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'lab.trend_budget_exceeded',
      );
      f.setTime(addSeconds(to, 10));
      const cropped = await entityTrend(
        new HistoryService(f.context, f.policy),
        header,
        'default-crop-query',
        f.lab.id,
        entity.id,
        { property: 'temperature', from, to },
      );
      assert.equal(cropped.observation_retention_seconds, 86400);
      assert.ok(cropped.raw_sample_count < response.raw_sample_count);
      assert.ok(cropped.gaps.some((gap) => gap.reasons.includes('retention')));
      assert.ok(
        cropped.segments
          .flatMap((segment) => segment.samples)
          .every(
            (sample) =>
              instantNanoseconds(sample.received_at) >=
              instantNanoseconds(addSeconds(from, 10)),
          ),
      );
    } finally {
      await f.close();
    }
  },
);
test('internal.trend: nanosecond half-open ranges and recorded quality/unit/source boundaries preserve actual samples', async () => {
  const f = await deviceHttpFixture();
  try {
    const entity = await f.register('sensor'),
      run = await f.start(entity.id),
      at = '2026-10-10T12:00:00.123456789Z',
      header = new Headers({ cookie: f.client.cookie! }),
      history = new HistoryService(f.context, f.policy);
    f.setTime(at);
    await f.runtime.report(run.binding_id, run.id, {
      sequence: 1,
      values: { temperature: 11 },
      observed_at: at,
      quality: 'good',
    });
    const include = await entityTrend(
      history,
      header,
      'nanosecond-include',
      f.lab.id,
      entity.id,
      {
        property: 'temperature',
        from: at,
        to: '2026-10-10T12:00:00.123456790Z',
      },
    );
    assert.equal(include.raw_sample_count, 1);
    assert.equal(include.segments[0].samples[0].received_at, at);
    assert.equal(include.segments[0].samples[0].value, 11);
    const exclude = await entityTrend(
      history,
      header,
      'nanosecond-exclude',
      f.lab.id,
      entity.id,
      {
        property: 'temperature',
        from: '2026-10-10T12:00:00.123456788Z',
        to: at,
      },
    );
    assert.equal(exclude.raw_sample_count, 0);
    f.setTime(addSeconds(at, 1));
    await f.runtime.report(run.binding_id, run.id, {
      sequence: 2,
      values: { temperature: 12 },
      observed_at: null,
      quality: 'uncertain',
    });
    f.setTime(addSeconds(at, 2));
    await f.runtime.report(run.binding_id, run.id, {
      sequence: 3,
      values: { temperature: 13 },
      observed_at: f.context.clock.now(),
      quality: 'good',
    });
    // Recorded imported units/source variations are an explicit internal fixture, not a public producer API.
    await f.db.transaction(
      { id: 'recorded-metadata-fixture', kind: 'startup' },
      async (tx) => {
        await tx.execute(
          sql`update lab.observation_history set data=jsonb_set(jsonb_set(data,'{properties,temperature,unit}','"K"'::jsonb),'{properties,temperature,source}','"historical:fixture"'::jsonb) where entity_id=${entity.id}::uuid and data->>'sequence'='2'`,
        );
      },
    );
    const separated = await entityTrend(
      history,
      header,
      'metadata-boundaries-query',
      f.lab.id,
      entity.id,
      { property: 'temperature', from: at, to: addSeconds(at, 3) },
    );
    assert.equal(separated.segments.length, 3);
    assert.equal(separated.segments[1].unit, 'K');
    assert.equal(separated.segments[1].quality, 'uncertain');
    assert.equal(separated.segments[1].source_time_known, false);
    for (const reason of [
      'unit_changed',
      'source_changed',
      'quality_changed',
      'source_time_unknown',
      'source_time_restored',
    ])
      assert.ok(separated.gaps.some((gap) => gap.reasons.includes(reason)));
  } finally {
    await f.close();
  }
});
