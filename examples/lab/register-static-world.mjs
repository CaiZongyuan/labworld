import assert from 'node:assert/strict';
const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const key = process.env.LAB_API_KEY;
if (!key) throw new Error('Set LAB_API_KEY to an active lab:full credential');
async function request(method, path, body, status = 200) {
  const response = await fetch(`${base}/api/v1/lab${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, status, `${method} ${path}: unexpected status`);
  return response.json();
}
const labId =
  process.env.LAB_ID ??
  (await request('POST', '/labs', { name: 'Static identity tutorial' }, 201))
    .id;
const definitions = await request('GET', '/asset-definitions'),
  definition = definitions.data.find(
    (entry) => entry.id === 'robot' && entry.version === '1.0',
  );
assert(definition);
const input = {
  name: 'Robot A',
  definition_id: definition.id,
  definition_version: definition.version,
  reality: 'simulated',
  configuration: { label: 'A' },
  representation_id: process.env.LAB_REPRESENTATION_ID ?? null,
};
const before = await request('GET', `/labs/${labId}/world`);
await request(
  'POST',
  `/labs/${labId}/entities`,
  { ...input, definition_version: 'missing' },
  400,
);
assert.deepEqual(await request('GET', `/labs/${labId}/world`), before);
const entities = [];
for (const name of ['Robot A', 'Robot B'])
  entities.push(
    await request('POST', `/labs/${labId}/entities`, { ...input, name }, 201),
  );
assert.notEqual(entities[0].id, entities[1].id);
const world = await request(
  'GET',
  `/labs/${labId}/world?kind=robot&capability=robot.pick&state=unknown`,
);
for (const entity of entities) {
  const read = world.entities.find((entry) => entry.id === entity.id);
  assert(read);
  assert.equal(read.binding, null);
  assert.equal(read.program_run, null);
  assert.equal(read.observation, null);
  assert.equal(read.capabilities.filter((entry) => entry.executable).length, 0);
}
console.log(
  JSON.stringify(
    {
      lab_id: labId,
      entity_ids: entities.map((entity) => entity.id),
      node_ids: world.nodes.map((node) => node.id),
      declared_capabilities: definition.capabilities.map(
        (capability) => capability.id,
      ),
      executable_capabilities: [],
    },
    null,
    2,
  ),
);
