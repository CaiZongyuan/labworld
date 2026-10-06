import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type {
  CreatedApiKey,
  PersistentLab,
  LabEntity,
  LabWorld,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
test('real snapshots at 1 and 100 Entities with ten concurrent Member/Agent callers return all identities and references within ten submitted SQL', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  target.env.RATE_LIMIT_ENABLED = 'false';
  const counts: number[] = [];
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const key = await client.json<CreatedApiKey>(
        'POST',
        '/api/v1/api-keys',
        { name: 'Snapshot Agent', scopes: ['lab:full'], expires_in_days: 1 },
        201,
      ),
      agent = new CoreHttp(target.url),
      authorization = { authorization: `Bearer ${key.secret}` };
    const asset = await publishAsset(
      client,
      await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
      'Snapshot model',
    );
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Counted snapshots' },
        201,
      ),
      path = `/api/v1/lab/labs/${lab.id}`;
    const identities = new Set<string>();
    async function measure(
      actor: CoreHttp,
      headers: Record<string, string>,
      expected: number,
    ) {
      const response = await actor.response(
        'GET',
        path + '/world',
        undefined,
        headers,
      );
      assert.equal(response.status, 200);
      const id = response.headers.get('x-request-id')!;
      const world = (await response.json()) as LabWorld;
      assert.equal(world.entities.length, expected);
      assert.equal(world.nodes.length, expected);
      assert.deepEqual(
        new Set(world.entities.map((entity) => entity.id)),
        identities,
      );
      assert.ok(world.nodes.every((node) => identities.has(node.entity_id)));
      assert.deepEqual(world.assets, [asset]);
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
                    kind: string;
                    statements: number;
                    commands: string[];
                    outcome: string;
                  },
                ];
              } catch {
                return [];
              }
            })
            .find(
              (value) =>
                value.event === 'database.operation' && value.id === id,
            ),
        (value) => value !== undefined,
      );
      assert.equal(measured!.kind, 'request');
      assert.equal(measured!.outcome, 'ok');
      assert.ok(measured!.commands.includes('BEGIN'));
      assert.ok(measured!.commands.includes('COMMIT'));
      assert.equal(measured!.statements, measured!.commands.length);
      assert.ok(measured!.statements <= 10);
      if (actor === agent)
        assert.ok(
          measured!.commands.some((command) => command.startsWith('UPDATE')),
        );
      counts.push(measured!.statements);
      return world;
    }
    for (let index = 0; index < 100; index++) {
      const entity = await client.json<LabEntity>(
        'POST',
        path + '/entities',
        {
          name: `Counted ${index}`,
          definition_id: 'model',
          definition_version: '1.0',
          reality: 'physical',
          configuration: { index },
          representation_id: asset.representation.id,
        },
        201,
      );
      identities.add(entity.id);
      if (index === 0) {
        await measure(client, {}, 1);
        await measure(agent, authorization, 1);
      }
    }
    const full = await measure(client, {}, 100);
    assert.deepEqual(await measure(agent, authorization, 100), full);
    const pending = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        measure(
          index % 2 ? agent : client,
          index % 2 ? authorization : {},
          100,
        ),
      ),
    );
    for (const outcome of pending) {
      if (outcome.status === 'rejected') throw outcome.reason;
      assert.deepEqual(outcome.value, full);
    }
    console.log(
      JSON.stringify({
        event: 'm3a.world-sql-budget',
        sizes: [1, 100],
        concurrency: 10,
        requests: counts.length,
        maximum: Math.max(...counts),
        counts,
      }),
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'm3a.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('actual extra submitted snapshot SQL crosses the unchanged budget and a normal retry preserves all state', async () => {
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
        { name: 'Budget refusal' },
        201,
      ),
      path = `/api/v1/lab/labs/${lab.id}/world`;
    const before = await client.json<LabWorld>('GET', path),
      response = await client.response('GET', path, undefined, {
        'x-owned-extra-sql': '1',
      });
    assert.equal(response.status, 500);
    const id = response.headers.get('x-request-id')!,
      failure = (await response.json()) as { error: { code: string } };
    assert.equal(failure.error.code, 'internal.error');
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
                  kind: string;
                  statements: number;
                  commands: string[];
                  budget: number;
                },
              ];
            } catch {
              return [];
            }
          })
          .find(
            (value) => value.event === 'database.operation' && value.id === id,
          ),
      (value) => value !== undefined,
    );
    assert.equal(measured!.budget, 10);
    assert.equal(measured!.kind, 'request');
    assert.ok(
      measured!.commands.filter((command) => command === 'SELECT 1').length > 2,
    );
    assert.deepEqual(await client.json<LabWorld>('GET', path), before);
    console.log(
      JSON.stringify({
        event: 'm3a.world-budget-control',
        status: response.status,
        statements: measured!.statements,
        commands: measured!.commands,
        budget: measured!.budget,
      }),
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'm3a.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});
