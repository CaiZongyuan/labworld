import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CreatedApiKey,
  PersistentLab,
  LabWorld,
  LabEntity,
  SceneNode,
  AssetDefinition,
  LabLayout,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
import { readFile } from 'node:fs/promises';

test('Member and Agent share a persistent Lab; CSRF refusal preserves its world across reopen', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const member = new CoreHttp(target.url);
    await member.register('member@example.test');
    assert.equal(member.session!.user.role, 'member');
    const key = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'World Agent', scopes: ['lab:full'], expires_in_days: 1 },
      201,
    );
    const agent = new CoreHttp(target.url),
      authorization = { authorization: `Bearer ${key.secret}` };
    const lab = await member.json<PersistentLab>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Persistent shared Lab' },
      201,
    );
    assert.match(lab.id, /^[0-9a-f-]{36}$/);
    assert.equal(lab.created_by, member.session!.user.id);
    assert.equal(lab.layout_version, 0);
    const path = `/api/v1/lab/labs/${lab.id}/world`;
    const snapshot = await member.json<LabWorld>('GET', path);
    assert.deepEqual(snapshot.lab, lab);
    assert.equal(typeof snapshot.version, 'string');
    for (const values of [
      snapshot.entities,
      snapshot.nodes,
      snapshot.assets,
      snapshot.relationships,
    ])
      assert.deepEqual(values, []);
    assert.deepEqual(
      await agent.json<LabWorld>('GET', path, undefined, 200, authorization),
      snapshot,
    );
    await member.error(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Denied' },
      403,
      'auth.csrf',
      { 'x-csrf-token': '' },
    );
    assert.deepEqual(await member.json<LabWorld>('GET', path), snapshot);
    await target.stop();
    await target.start();
    await member.login('member@example.test');
    assert.deepEqual(await member.json<LabWorld>('GET', path), snapshot);
    const list = await member.json<{ data: PersistentLab[] }>(
      'GET',
      '/api/v1/lab/labs',
    );
    assert.deepEqual(list.data, [lab]);
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

test('catalog and filtered physical/simulated Robots retain separate unknown identities and directional manual simulation links', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const definition = await client.json<AssetDefinition>(
        'GET',
        '/api/v1/lab/asset-definitions/robot/1.0',
      ),
      catalog = await client.json<{ data: AssetDefinition[] }>(
        'GET',
        '/api/v1/lab/asset-definitions',
      );
    assert.ok(catalog.data.some((entry) => entry.id === 'bench'));
    assert.equal(definition.capabilities.length, 3);
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Distinct Robots' },
        201,
      ),
      path = `/api/v1/lab/labs/${lab.id}`;
    const input = {
      name: 'Robot',
      definition_id: 'robot',
      definition_version: '1.0',
      configuration: {},
      representation_id: null,
    };
    const simulated = await client.json<LabEntity>(
        'POST',
        path + '/entities',
        { ...input, reality: 'simulated' },
        201,
      ),
      physical = await client.json<LabEntity>(
        'POST',
        path + '/entities',
        { ...input, reality: 'physical' },
        201,
      );
    assert.notEqual(simulated.id, physical.id);
    await client.json<LabEntity>(
      'POST',
      path + '/entities',
      { ...input, name: 'Bench', definition_id: 'bench', reality: 'simulated' },
      201,
    );
    const filtered = await client.json<LabWorld>(
      'GET',
      path + '/world?kind=robot&capability=robot.pick&state=unknown',
    );
    assert.equal(filtered.entities.length, 2);
    assert.equal(filtered.nodes.length, 2);
    for (const entity of filtered.entities) {
      assert.deepEqual(entity.definition, definition);
      assert.equal(entity.binding, null);
      assert.equal(entity.program_run, null);
      assert.equal(entity.observation, null);
      assert.ok(
        entity.capabilities.every(
          (capability) =>
            capability.definition_supported &&
            !capability.binding_implemented &&
            !capability.executable &&
            capability.reason === 'binding_not_implemented',
        ),
      );
    }
    const all = await client.json<LabWorld>('GET', path + '/world'),
      nodes = all.nodes.map(
        ({ id, entity_id, representation_id, placement }) => ({
          id,
          entity_id,
          representation_id,
          placement,
        }),
      );
    const relationship = {
      id: '88a9fe22-d20d-4ce9-b09f-89e74bc307f7',
      source_id: simulated.id,
      target_id: physical.id,
      kind: 'simulates',
    };
    const rawFloat = await fetch(client.url + path + '/layout', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: client.url,
        cookie: client.cookie!,
        'x-csrf-token': client.csrf!,
      },
      body: JSON.stringify({
        expected_version: all.lab.layout_version,
        nodes,
        relationships: [relationship],
      }).replace(
        '"expected_version":' + all.lab.layout_version,
        '"expected_version":' + all.lab.layout_version + '.0',
      ),
    });
    assert.equal(rawFloat.status, 400);
    assert.equal((await rawFloat.json()).error.code, 'http.invalid_json');
    assert.deepEqual(await client.json<LabWorld>('GET', path + '/world'), all);
    await client.error(
      'PUT',
      path + '/layout',
      {
        expected_version: all.lab.layout_version + 0.5,
        nodes,
        relationships: [relationship],
      },
      400,
      'http.invalid_json',
    );
    assert.deepEqual(await client.json<LabWorld>('GET', path + '/world'), all);
    const saved = await client.json<LabLayout>('PUT', path + '/layout', {
      expected_version: all.lab.layout_version,
      nodes,
      relationships: [relationship],
    });
    assert.equal(saved.relationships[0].source, 'manual');
    assert.equal(saved.relationships[0].registered_by, client.session!.user.id);
    const before = await client.json<LabWorld>('GET', path + '/world');
    await client.error(
      'PUT',
      path + '/layout',
      {
        expected_version: before.lab.layout_version,
        nodes,
        relationships: [
          { ...relationship, source_id: physical.id, target_id: simulated.id },
        ],
      },
      400,
      'lab.invalid_reference',
    );
    assert.deepEqual(
      await client.json<LabWorld>('GET', path + '/world'),
      before,
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

test('multiple Entities and Nodes share one model; copying preserves frozen facts with a new identity and stale copies refuse', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const asset = await publishAsset(
      client,
      await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
      'Shared model',
    );
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Represented objects' },
        201,
      ),
      path = `/api/v1/lab/labs/${lab.id}`;
    const input = {
      name: 'First model',
      definition_id: 'model',
      definition_version: '1.0',
      reality: 'physical',
      configuration: { label: 'One' },
      representation_id: asset.representation.id,
    };
    const first = await client.json<LabEntity>(
        'POST',
        path + '/entities',
        input,
        201,
      ),
      second = await client.json<LabEntity>(
        'POST',
        path + '/entities',
        { ...input, name: 'Second model' },
        201,
      );
    assert.notEqual(first.id, second.id);
    const extra = await client.json<SceneNode>(
      'POST',
      path + '/nodes',
      {
        entity_id: first.id,
        representation_id: asset.representation.id,
        placement: {
          position: [3, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
      201,
    );
    let world = await client.json<LabWorld>('GET', path + '/world');
    assert.equal(
      world.nodes.filter((node) => node.entity_id === first.id).length,
      2,
    );
    assert.deepEqual(world.assets, [asset]);
    assert.notEqual(extra.id, first.id);
    const before = world,
      copyInput = {
        expected_version: world.lab.layout_version,
        name: 'Independent copy',
        placement: {
          position: [4, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      };
    const copied = await client.json<LabEntity>(
      'POST',
      path + `/entities/${first.id}/copies`,
      copyInput,
      201,
    );
    assert.notEqual(copied.id, first.id);
    assert.deepEqual(copied.definition, first.definition);
    assert.deepEqual(copied.configuration, first.configuration);
    assert.equal(copied.reality, 'physical');
    assert.equal(copied.representation_id, asset.representation.id);
    assert.equal(copied.program_run, null);
    assert.equal(copied.observation, null);
    world = await client.json<LabWorld>('GET', path + '/world');
    assert.equal(world.entities.length, 3);
    assert.equal(world.nodes.length, 4);
    assert.ok(world.lab.layout_version > before.lab.layout_version);
    await client.error(
      'POST',
      path + `/entities/${first.id}/copies`,
      { ...copyInput, name: 'Stale copy' },
      409,
      'lab.layout_conflict',
    );
    assert.deepEqual(
      await client.json<LabWorld>('GET', path + '/world'),
      world,
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

test('static Entity registration freezes its definition and keeps independent Scene Node identity through configuration and reopen', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Independent objects' },
        201,
      ),
      path = `/api/v1/lab/labs/${lab.id}`;
    const entity = await client.json<LabEntity>(
      'POST',
      path + '/entities',
      {
        name: 'North bench',
        definition_id: 'bench',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: { label: 'North' },
        representation_id: null,
      },
      201,
    );
    assert.equal(entity.kind, 'furniture');
    assert.equal(entity.definition.id, 'bench');
    assert.equal(entity.binding, null);
    assert.equal(entity.program_run, null);
    assert.equal(entity.observation, null);
    const snapshot = await client.json<LabWorld>('GET', path + '/world');
    assert.deepEqual(snapshot.entities, [entity]);
    assert.equal(snapshot.nodes.length, 1);
    assert.notEqual(snapshot.nodes[0].id, entity.id);
    assert.equal(snapshot.nodes[0].entity_id, entity.id);
    assert.deepEqual(snapshot.nodes[0].placement, {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    const configured = await client.json<LabEntity>(
      'PATCH',
      path + `/entities/${entity.id}`,
      { name: 'Configured bench', configuration: { label: 'West' } },
    );
    assert.equal(configured.id, entity.id);
    assert.deepEqual(configured.definition, entity.definition);
    assert.equal(configured.configuration.label, 'West');
    const before = await client.json<LabWorld>('GET', path + '/world');
    await client.error(
      'POST',
      path + '/entities',
      {
        name: 'Invalid',
        definition_id: 'bench',
        definition_version: 'missing',
        reality: 'simulated',
        configuration: {},
        representation_id: null,
      },
      400,
      'lab.invalid_reference',
    );
    assert.deepEqual(
      await client.json<LabWorld>('GET', path + '/world'),
      before,
    );
    await target.stop();
    await target.start();
    await client.login('member@example.test');
    assert.deepEqual(
      await client.json<LabEntity>('GET', path + `/entities/${entity.id}`),
      configured,
    );
    assert.deepEqual(
      await client.json<LabWorld>('GET', path + '/world'),
      before,
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
