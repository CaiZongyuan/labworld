import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  PersistentLab,
  LabEntity,
  LabWorld,
  LabLayout,
  SceneNode,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test('1000 real Entities and Nodes refuse the 1001st without partial change; freeing Node space preserves Entity capacity', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.RATE_LIMIT_ENABLED = 'false';
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Entity capacity' },
        201,
      ),
      path = `/api/v1/lab/labs/${lab.id}`;
    const input = {
      name: 'Capacity Entity '.padEnd(120, 'x'),
      definition_id: 'bench',
      definition_version: '1.0',
      reality: 'simulated',
      configuration: {},
      representation_id: null,
    };
    const identities = new Set<string>();
    let first!: LabEntity;
    for (let index = 0; index < 1000; index++) {
      const entity = await client.json<LabEntity>(
        'POST',
        path + '/entities',
        input,
        201,
      );
      identities.add(entity.id);
      first ??= entity;
    }
    assert.equal(identities.size, 1000);
    const full = await client.json<LabWorld>('GET', path + '/world');
    assert.equal(full.entities.length, 1000);
    assert.equal(full.nodes.length, 1000);
    await client.error(
      'POST',
      path + '/entities',
      input,
      400,
      'lab.invalid_input',
    );
    const node = {
      entity_id: first.id,
      representation_id: null,
      placement: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    };
    await client.error('POST', path + '/nodes', node, 400, 'lab.invalid_input');
    assert.deepEqual(await client.json<LabWorld>('GET', path + '/world'), full);
    const reduced = await client.json<LabLayout>('PUT', path + '/layout', {
      expected_version: full.lab.layout_version,
      nodes: full.nodes
        .slice(1)
        .map(({ id, entity_id, representation_id, placement }) => ({
          id,
          entity_id,
          representation_id,
          placement,
        })),
    });
    assert.equal(reduced.nodes.length, 999);
    const before = await client.json<LabWorld>('GET', path + '/world');
    await client.error(
      'POST',
      path + '/entities',
      input,
      400,
      'lab.invalid_input',
    );
    assert.deepEqual(
      await client.json<LabWorld>('GET', path + '/world'),
      before,
    );
    await client.json<SceneNode>('POST', path + '/nodes', node, 201);
    const recovered = await client.json<LabWorld>('GET', path + '/world');
    assert.equal(recovered.entities.length, 1000);
    assert.equal(recovered.nodes.length, 1000);
    assert.deepEqual(
      new Set(recovered.entities.map((entity) => entity.id)),
      identities,
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
