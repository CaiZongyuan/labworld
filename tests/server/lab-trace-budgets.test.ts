import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CreatedApiKey,
  LabEntity,
  PersistentLab,
  LabRecordsPage,
  EntityTrend,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test('extra submitted records/trend SQL exceeds the unchanged ten-statement budget, preserves World, and a normal retry recovers', async () => {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/lab-budget-fault.ts';
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const client = new CoreHttp(target.url);
    await client.register('owner@example.test');
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Bounded trace counterexample' },
        201,
      ),
      path = '/api/v1/lab/labs/' + lab.id;
    const entity = await client.json<LabEntity>(
      'POST',
      path + '/entities',
      {
        name: 'Sensor',
        definition_id: 'sensor',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: {},
        representation_id: null,
      },
      201,
    );
    await client.json(
      'POST',
      path + '/entities/' + entity.id + '/program/start',
      undefined,
      201,
    );
    await until(
      () => client.json<LabEntity>('GET', path + '/entities/' + entity.id),
      (value) => !!value.observation,
    );
    await client.json(
      'POST',
      path + '/entities/' + entity.id + '/program/stop',
    );
    const range = {
        from: new Date(Date.now() - 60000).toISOString(),
        to: new Date(Date.now() + 1000).toISOString(),
      },
      before = await client.json('GET', path + '/world');
    for (const url of [
      path + '/records?' + new URLSearchParams(range),
      path +
        '/entities/' +
        entity.id +
        '/trend?' +
        new URLSearchParams({ ...range, property: 'temperature' }),
    ]) {
      await client.json('GET', url);
      const response = await client.response('GET', url, undefined, {
        'x-owned-extra-sql': '1',
      });
      assert.equal(response.status, 500);
      const id = response.headers.get('x-request-id')!;
      await response.arrayBuffer();
      const measured = await until(
        async () =>
          target.logs
            .split('\n')
            .flatMap((line) => {
              try {
                return [
                  JSON.parse(line) as {
                    event: string;
                    id: string;
                    statements: number;
                    budget: number;
                  },
                ];
              } catch {
                return [];
              }
            })
            .find((row) => row.event === 'database.operation' && row.id === id),
        (row) => !!row,
      );
      assert.equal(measured!.budget, 10);
      assert.ok(measured!.statements > 10);
      assert.deepEqual(await client.json('GET', path + '/world'), before);
      await client.json('GET', url);
      console.log(
        JSON.stringify({
          event: 'm3b.trace-budget-control',
          endpoint: url.includes('/records?') ? 'records' : 'trend',
          statements: measured!.statements,
          status: response.status,
        }),
      );
    }
  } finally {
    await target.cleanup();
  }
});
test('actual records and database trends at 1/100 Entities and concurrent Member/Agent reads include auth and controls within ten SQL', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.RATE_LIMIT_ENABLED = 'false';
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const member = new CoreHttp(target.url);
    await member.register('member@example.test');
    const key = await member.json<CreatedApiKey>(
        'POST',
        '/api/v1/api-keys',
        {
          name: 'Counted trace Agent',
          scopes: ['lab:full'],
          expires_in_days: 1,
        },
        201,
      ),
      agent = new CoreHttp(target.url),
      authorization = { authorization: 'Bearer ' + key.secret };
    const lab = await member.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Counted trace' },
        201,
      ),
      path = '/api/v1/lab/labs/' + lab.id;
    const sensor = await member.json<LabEntity>(
      'POST',
      path + '/entities',
      {
        name: 'Counted sensor',
        definition_id: 'sensor',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: {},
        representation_id: null,
      },
      201,
    );
    await member.json(
      'POST',
      path + '/entities/' + sensor.id + '/program/start',
      undefined,
      201,
    );
    await until(
      () => member.json<LabEntity>('GET', path + '/entities/' + sensor.id),
      (value) => (value.observation?.sequence ?? 0) >= 2,
    );
    const query = {
        from: new Date(Date.now() - 60000).toISOString(),
        to: new Date(Date.now() + 60000).toISOString(),
      },
      records = path + '/records?',
      trend =
        path +
        '/entities/' +
        sensor.id +
        '/trend?' +
        new URLSearchParams({ ...query, property: 'temperature' });
    async function measure(
      url: string,
      actor: CoreHttp,
      headers: Record<string, string>,
    ) {
      const response = await actor.response('GET', url, undefined, headers);
      assert.equal(response.status, 200);
      const id = response.headers.get('x-request-id')!,
        body = await response.json();
      const count = await until(
        async () =>
          target.logs
            .split('\n')
            .flatMap((line) => {
              try {
                return [
                  JSON.parse(line) as {
                    event: string;
                    id: string;
                    statements: number;
                    commands: string[];
                    kind: string;
                    outcome: string;
                  },
                ];
              } catch {
                return [];
              }
            })
            .find((row) => row.event === 'database.operation' && row.id === id),
        (value) => value !== undefined,
      );
      assert.equal(count!.kind, 'request');
      assert.equal(count!.outcome, 'ok');
      assert.ok(count!.commands.includes('BEGIN'));
      assert.ok(count!.commands.includes('COMMIT'));
      assert.equal(count!.statements, count!.commands.length);
      assert.ok(count!.statements <= 10);
      return { body, count: count!.statements };
    }
    const first = await measure(
        records +
          new URLSearchParams({ ...query, entity_id: sensor.id, limit: '1' }),
        agent,
        authorization,
      ),
      cursor = (first.body as LabRecordsPage).next_cursor!;
    assert.ok(cursor);
    const continuation =
      records +
      new URLSearchParams({
        ...query,
        entity_id: sensor.id,
        limit: '1',
        cursor,
      });
    const counts: number[] = [];
    for (const size of [1, 100]) {
      if (size === 100)
        for (let index = 1; index < 100; index++)
          await member.json(
            'POST',
            path + '/entities',
            {
              name: 'Static ' + index,
              definition_id: 'model',
              definition_version: '1.0',
              reality: 'physical',
              configuration: {},
              representation_id: null,
            },
            201,
          );
      for (const [actor, headers] of [
        [member, {}],
        [agent, authorization],
      ] as const) {
        const a = await measure(continuation, actor, headers);
        assert.ok((a.body as LabRecordsPage).items.length);
        counts.push(a.count);
        const b = await measure(trend, actor, headers);
        assert.ok((b.body as EntityTrend).returned_sample_count >= 2);
        counts.push(b.count);
      }
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          measure(
            index % 2 ? trend : continuation,
            index % 3 ? member : agent,
            index % 3 ? {} : authorization,
          ),
        ),
      );
      counts.push(...concurrent.map((value) => value.count));
    }
    console.log(
      JSON.stringify({
        event: 'm3b.trace-sql-budget',
        sizes: [1, 100],
        concurrency: 10,
        maximum: Math.max(...counts),
        counts,
        ledger: target.evidence + '/owned-resources.json',
      }),
    );
  } finally {
    await target.cleanup();
  }
});
