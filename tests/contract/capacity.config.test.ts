import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type {
  LabEntity,
  LabLayout,
  SceneNode,
} from '../../packages/contracts/src/generated/types.gen';
import { member } from './http';
import { createLab, world } from './lab';
import { WorldStream } from './sse';
const placement = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

test('CAPACITY-01 exactly 1000 Entity and automatic Nodes are admitted; quota+1 leaves world unchanged and freed Node capacity recovers', async () => {
  const client = await member();
  const lab = (await createLab(client, 'Entity capacity')).id;
  const input = {
    name: 'Capacity Entity '.padEnd(120, 'x'),
    definition_id: 'bench',
    definition_version: '1.0',
    reality: 'simulated',
    configuration: {},
    representation_id: null,
  };
  const entities: LabEntity[] = [];
  for (let index = 0; index < 1000; index++)
    entities.push(
      await client.json<LabEntity>(
        'POST',
        `/api/v1/lab/labs/${lab}/entities`,
        input,
        201,
      ),
    );
  expect(new Set(entities.map((entity) => entity.id)).size).toBe(1000);
  const full = await world(client, lab);
  expect(full.entities).toHaveLength(1000);
  expect(full.nodes).toHaveLength(1000);
  await client.error('POST', `/api/v1/lab/labs/${lab}/entities`, input, 400);
  await client.error(
    'POST',
    `/api/v1/lab/labs/${lab}/nodes`,
    { entity_id: entities[0].id, placement, representation_id: null },
    400,
  );
  expect(await world(client, lab)).toEqual(full);
  const reduced = await client.json<LabLayout>(
    'PUT',
    `/api/v1/lab/labs/${lab}/layout`,
    {
      expected_version: full.lab.layout_version,
      nodes: full.nodes
        .slice(1)
        .map(({ id, entity_id, representation_id, placement }) => ({
          id,
          entity_id,
          representation_id,
          placement,
        })),
    },
  );
  expect(reduced.nodes).toHaveLength(999);
  const before = await world(client, lab);
  await client.error('POST', `/api/v1/lab/labs/${lab}/entities`, input, 400);
  expect(await world(client, lab)).toEqual(before);
  await client.json<SceneNode>(
    'POST',
    `/api/v1/lab/labs/${lab}/nodes`,
    { entity_id: entities[0].id, placement, representation_id: null },
    201,
  );
  const recovered = await world(client, lab);
  expect(recovered.entities).toHaveLength(1000);
  expect(recovered.nodes).toHaveLength(1000);
  const eventBytes = Buffer.byteLength(
    JSON.stringify({ type: 'snapshot', world: recovered }),
  );
  expect(
    eventBytes,
    'fixture must really exceed the event byte budget',
  ).toBeGreaterThan(1024 * 1024);
  await client.error(
    'GET',
    `/api/v1/lab/labs/${lab}/world/subscribe`,
    undefined,
    413,
    'lab.snapshot_too_large',
  );
  const small = await createLab(client, 'Recover event budget');
  const stream = await WorldStream.open(client, small.id);
  try {
    expect((await stream.next())?.type).toBe('snapshot');
  } finally {
    stream.close();
  }
}, 120_000);

test('CAPACITY-02 Scene Node capacity is independent of Entity count; oversized layout rejects and a valid layout restores capacity', async () => {
  const client = await member();
  const lab = (await createLab(client, 'Node capacity')).id;
  const entity = await client.json<LabEntity>(
    'POST',
    `/api/v1/lab/labs/${lab}/entities`,
    {
      name: 'One represented identity',
      definition_id: 'bench',
      definition_version: '1.0',
      reality: 'simulated',
      configuration: {},
      representation_id: null,
    },
    201,
  );
  for (let index = 1; index < 1000; index++)
    await client.json<SceneNode>(
      'POST',
      `/api/v1/lab/labs/${lab}/nodes`,
      { entity_id: entity.id, placement, representation_id: null },
      201,
    );
  const full = await world(client, lab);
  expect(full.entities).toHaveLength(1);
  expect(full.nodes).toHaveLength(1000);
  const nodes = full.nodes.map(
    ({ id, entity_id, representation_id, placement }) => ({
      id,
      entity_id,
      representation_id,
      placement,
    }),
  );
  await client.error(
    'PUT',
    `/api/v1/lab/labs/${lab}/layout`,
    {
      expected_version: full.lab.layout_version,
      nodes: [
        ...nodes,
        {
          id: randomUUID(),
          entity_id: entity.id,
          representation_id: null,
          placement,
        },
      ],
    },
    400,
  );
  await client.error(
    'POST',
    `/api/v1/lab/labs/${lab}/nodes`,
    { entity_id: entity.id, placement, representation_id: null },
    400,
  );
  expect(await world(client, lab)).toEqual(full);
  await client.json('PUT', `/api/v1/lab/labs/${lab}/layout`, {
    expected_version: full.lab.layout_version,
    nodes: nodes.slice(1),
  });
  await client.json<SceneNode>(
    'POST',
    `/api/v1/lab/labs/${lab}/nodes`,
    { entity_id: entity.id, placement, representation_id: null },
    201,
  );
  const recovered = await world(client, lab);
  expect(recovered.entities).toHaveLength(1);
  expect(recovered.nodes).toHaveLength(1000);
}, 120_000);

test('CAPACITY-03 actual 100-item history and record pages stay within 256 KiB and return remaining identities once', async () => {
  const client = await member();
  const lab = (await createLab(client, 'Page capacity')).id;
  const { register, start, action, settledCommand, entityPath, readEntity } =
    await import('./lab');
  const { until } = await import('./http');
  const entity = await register(client, lab, 'light');
  await start(client, lab, entity.id);
  const from = new Date(Date.now() - 1000).toISOString();
  const commands = [];
  try {
    for (let index = 0; index < 101; index++)
      commands.push(
        await action(client, lab, entity.id, 'light.set_power', {
          on: index % 2 === 0,
        }),
      );
    await settledCommand(client, lab, entity.id, commands.at(-1)!.id);
    const to = new Date().toISOString();
    for (const endpoint of [
      `${entityPath(lab, entity.id)}/history`,
      `/api/v1/lab/labs/${lab}/records`,
    ]) {
      const query = new URLSearchParams({
        record_type: 'command',
        from,
        to,
        limit: '100',
      });
      const response = await client.response('GET', `${endpoint}?${query}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262144);
      const first = JSON.parse(text) as {
        items: Array<{ id: string }>;
        next_cursor: string;
      };
      expect(first.items).toHaveLength(100);
      expect(first.next_cursor).toEqual(expect.any(String));
      query.set('cursor', first.next_cursor);
      const next = await client.json<typeof first>(
        'GET',
        `${endpoint}?${query}`,
      );
      expect(next.items).toHaveLength(1);
      expect(
        new Set([...first.items, ...next.items].map((item) => item.id)),
      ).toEqual(new Set(commands.map((command) => command.id)));
    }
  } finally {
    await client.json('POST', `${entityPath(lab, entity.id)}/program/stop`);
    await until(
      () => readEntity(client, lab, entity.id),
      (current) =>
        Object.values(current.observation?.properties ?? {}).every(
          (property) => property.freshness === 'stale',
        ),
      15_000,
      500,
    );
  }
});
