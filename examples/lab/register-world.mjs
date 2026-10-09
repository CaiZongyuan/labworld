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

const labId =
  process.env.LAB_ID ??
  (await request('POST', '/labs', { name: 'Identity tutorial' }, 201)).id;
const definitions = await request('GET', '/asset-definitions');
const robot = definitions.data.find(
  (entry) => entry.id === 'robot' && entry.version === '1.0',
);
assert(robot);
const entities = [];
for (const name of ['Robot A', 'Robot B']) {
  entities.push(
    await request(
      'POST',
      `/labs/${labId}/entities`,
      {
        name,
        definition_id: robot.id,
        definition_version: robot.version,
        reality: 'simulated',
        configuration: { label: name },
        representation_id: null,
      },
      201,
    ),
  );
}
assert.notEqual(entities[0].id, entities[1].id);
const world = await request(
  'GET',
  `/labs/${labId}/world?kind=robot&capability=robot.pick&state=unknown`,
);
for (const entity of entities) {
  const read = world.entities.find((entry) => entry.id === entity.id);
  assert(read);
  assert.equal(read.binding, null);
  assert.equal(read.observation, null);
  assert.equal(read.capabilities.filter((entry) => entry.executable).length, 0);
  const denied = await request(
    'POST',
    `/labs/${labId}/entities/${entity.id}/actions`,
    { capability: 'robot.pick', parameters: {} },
    422,
  );
  assert.equal(denied.error.code, 'lab.capability_not_implemented');
}
const after = await request(
  'GET',
  `/labs/${labId}/world?kind=robot&capability=robot.pick&state=unknown`,
);
assert.deepEqual(after, world);
console.log(
  JSON.stringify(
    {
      lab_id: labId,
      entity_ids: entities.map((entity) => entity.id),
      node_ids: world.nodes.map((node) => node.id),
      declared_capabilities: entities[0].capabilities.map((entry) => entry.id),
      executable_capabilities: [],
    },
    null,
    2,
  ),
);
