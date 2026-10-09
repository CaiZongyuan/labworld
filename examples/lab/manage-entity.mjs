import assert from 'node:assert/strict';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const { LAB_API_KEY: secret, LAB_ID: lab, LAB_ENTITY_ID: entity } = process.env;
if (!secret || !lab || !entity)
  throw new Error(
    'Set LAB_API_KEY, LAB_ID and LAB_ENTITY_ID for a disposable stopped device.',
  );
const path = `/api/v1/lab/labs/${lab}/entities/${entity}`;
async function request(method, url, body, expected = 200) {
  const response = await fetch(new URL(url, base), {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, `${method} ${url}`);
  return response.json();
}
const before = await request('GET', path);
assert.equal(before.archived_at, null);
assert.ok(before.binding);
assert.notEqual(before.program_run?.status, 'running');
assert.ok(!before.task || before.task.ended_at);
const run = await request('POST', `${path}/program/start`, undefined, 201);
const rejected = await request('POST', `${path}/archive`, undefined, 409);
assert.equal(rejected.error.code, 'lab.entity_in_use');
const running = await request('GET', path);
const appearance = await request('PUT', `${path}/appearance`, {
  representation_id: process.env.LAB_REPRESENTATION_ID || null,
});
for (const field of [
  'id',
  'binding',
  'program_run',
  'definition',
  'configuration',
  'task',
  'task_result',
])
  assert.deepEqual(appearance[field], running[field]);
const stopped = await request('POST', `${path}/program/stop`);
const changed = await request('PUT', `${path}/definition`, {
  definition_id: process.env.LAB_DEFINITION_ID ?? 'sensor',
  definition_version: process.env.LAB_DEFINITION_VERSION ?? '1.0',
  configuration: {},
});
assert.equal(changed.id, entity);
assert.deepEqual(await request('GET', `${path}/runs/${run.id}`), stopped);
const archived = await request('POST', `${path}/archive`);
assert.equal(archived.id, entity);
assert.ok(archived.archived_at);
assert.equal(
  (await request('POST', `${path}/program/start`, undefined, 409)).error.code,
  'lab.entity_archived',
);
if (process.env.LAB_ASSET_ID)
  assert.equal(
    (
      await request(
        'DELETE',
        `/api/v1/lab/assets/${process.env.LAB_ASSET_ID}`,
        undefined,
        409,
      )
    ).error.code,
    'lab.asset_in_use',
  );
console.log(
  JSON.stringify(
    {
      entity: archived.id,
      archived_at: archived.archived_at,
      previous_run: stopped,
      current_binding: archived.binding,
    },
    null,
    2,
  ),
);
