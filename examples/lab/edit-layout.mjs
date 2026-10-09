import assert from 'node:assert/strict';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const secret = process.env.LAB_API_KEY;
if (!secret)
  throw new Error('Set LAB_API_KEY to an active lab:full credential');
async function request(method, path, body, expected = 200) {
  const response = await fetch(`${base}/api/v1/lab${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: unexpected status`,
  );
  return response.json();
}
const lab = process.env.LAB_ID
  ? { id: process.env.LAB_ID }
  : await request('POST', '/labs', { name: 'Layout tutorial' }, 201);
const path = `/labs/${lab.id}`;
async function register(name, definition, reality = 'simulated') {
  return request(
    'POST',
    `${path}/entities`,
    {
      name,
      definition_id: definition,
      definition_version: '1.0',
      reality,
      configuration: {},
      representation_id: null,
    },
    201,
  );
}
const bench = await register('North bench', 'bench');
const beaker = await register('Beaker A', 'labware');
const simulated = await register('Simulated Robot', 'robot');
const physical = await register('Physical Robot', 'robot', 'physical');
const nodesOf = (world) =>
  world.nodes.map(({ id, entity_id, representation_id, placement }) => ({
    id,
    entity_id,
    representation_id,
    placement,
  }));
const relationsOf = (world) =>
  world.relationships.map(({ id, source_id, target_id, kind }) => ({
    id,
    source_id,
    target_id,
    kind,
  }));
const read = () => request('GET', `${path}/world`);
const save = (
  world,
  nodes,
  relationships = relationsOf(world),
  expected = 200,
) =>
  request(
    'PUT',
    `${path}/layout`,
    { expected_version: world.lab.layout_version, nodes, relationships },
    expected,
  );
let world = await read();
let nodes = nodesOf(world);
nodes.find((node) => node.entity_id === beaker.id).placement = {
  position: [0, 0.9, 0.2],
  rotation: [0, 0.5, 0],
  scale: [1.2, 1.2, 1.2],
};
const relationships = [
  {
    id: crypto.randomUUID(),
    source_id: beaker.id,
    target_id: bench.id,
    kind: 'located_in',
  },
  {
    id: crypto.randomUUID(),
    source_id: simulated.id,
    target_id: physical.id,
    kind: 'simulates',
  },
];
await save(world, nodes, relationships);
const saved = await read();
assert(
  saved.relationships.every(
    (relation) =>
      relation.source === 'manual' &&
      relation.registered_by &&
      relation.registered_at,
  ),
);
const conflict = await save(world, nodes, relationships, 409);
assert.equal(conflict.error.code, 'lab.layout_conflict');
assert.deepEqual(await read(), saved);

world = await read();
nodes = nodesOf(world);
nodes.find((node) => node.entity_id === beaker.id).placement.position[0] = 0.15;
await save(world, nodes);
world = await read();
assert.deepEqual(world.relationships, saved.relationships);
nodes = nodesOf(world);
nodes.push({
  id: crypto.randomUUID(),
  entity_id: beaker.id,
  representation_id: null,
  placement: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
});
await save(world, nodes);
world = await read();
assert.equal(
  world.nodes.filter((node) => node.entity_id === beaker.id).length,
  2,
);
const copied = await request(
  'POST',
  `${path}/entities/${beaker.id}/copies`,
  {
    expected_version: world.lab.layout_version,
    name: 'Beaker B',
    placement: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
  201,
);
assert.notEqual(copied.id, beaker.id);
assert.deepEqual(copied.definition, beaker.definition);
assert.equal(copied.program_run, null);
assert.equal(copied.observation, null);
world = await read();
await save(
  world,
  nodesOf(world).filter((node) => node.entity_id !== beaker.id),
);
world = await read();
assert(world.entities.some((entity) => entity.id === beaker.id));
assert(!world.nodes.some((node) => node.entity_id === beaker.id));
await save(world, [
  ...nodesOf(world),
  {
    id: crypto.randomUUID(),
    entity_id: beaker.id,
    representation_id: null,
    placement: {
      position: [0, 0.9, 0.2],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  },
]);
world = await read();
const cycle = [
  ...relationsOf(world),
  {
    id: crypto.randomUUID(),
    source_id: beaker.id,
    target_id: bench.id,
    kind: 'contains',
  },
];
const rejected = await save(world, nodesOf(world), cycle, 400);
assert.equal(rejected.error.code, 'lab.invalid_reference');
assert.deepEqual(await read(), world);
console.log(
  JSON.stringify(
    {
      lab_id: lab.id,
      beaker_id: beaker.id,
      copied_entity_id: copied.id,
      layout_version: world.lab.layout_version,
      relationships: world.relationships,
    },
    null,
    2,
  ),
);
