import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const secret = process.env.LAB_API_KEY;
if (!secret)
  throw new Error('Set LAB_API_KEY to an active lab:full credential');
async function request(method, path, body, expected = 200, key) {
  const response = await fetch(`${base}/api/v1/lab${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
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
const lab =
  process.env.LAB_ID ??
  (await request('POST', '/labs', { name: 'Lighting tutorial' }, 201)).id;
const lights = [];
for (const [name, brightness] of [
  ['Light A', 70],
  ['Light B', 20],
]) {
  const entity = await request(
    'POST',
    `/labs/${lab}/entities`,
    {
      name,
      definition_id: 'light',
      definition_version: '1.0',
      reality: 'simulated',
      configuration: { brightness },
      representation_id: null,
    },
    201,
  );
  assert.equal(entity.observation, null);
  const path = `/labs/${lab}/entities/${entity.id}`;
  const run = await request('POST', `${path}/program/start`, undefined, 201);
  lights.push({ entity, path, run });
}
assert.notEqual(lights[0].run.id, lights[1].run.id);
async function apply(light, capability, parameters) {
  const input = { capability, parameters };
  const key = randomUUID();
  const accepted = await request(
    'POST',
    `${light.path}/actions`,
    input,
    202,
    key,
  );
  const query = `${light.path}/commands/${accepted.id}`;
  const deadline = Date.now() + 10000;
  let command;
  do {
    command = await request('GET', query);
    if (!['accepted', 'executing'].includes(command.status)) break;
    assert(
      Date.now() < deadline,
      'Command still pending; query its id before deciding what to do',
    );
    await setTimeout(100);
  } while (['accepted', 'executing'].includes(command.status));
  assert.equal(
    command.status,
    'succeeded',
    'Uncertain results must be queried, not resubmitted with a new key',
  );
  assert.equal(command.actor_source, 'agent');
  const retry = await request('POST', `${light.path}/actions`, input, 202, key);
  assert.equal(retry.id, accepted.id);
  assert.equal(retry.status, 'succeeded');
  const conflict = await request(
    'POST',
    `${light.path}/actions`,
    { capability: 'light.set_power', parameters: { on: false } },
    409,
    key,
  );
  assert.equal(conflict.error.code, 'idempotency.conflict');
  return command;
}
await apply(lights[0], 'light.set_power', { on: true });
await apply(lights[1], 'light.set_power', { on: true });
const command = await apply(lights[0], 'light.set_brightness', {
  brightness: 35,
});
const first = await request('GET', lights[0].path);
const second = await request('GET', lights[1].path);
assert.deepEqual(first.observation.values, { on: true, brightness: 35 });
assert.deepEqual(second.observation.values, { on: true, brightness: 20 });
assert.notEqual(first.observation.source, second.observation.source);
const stopped = await request('POST', `${lights[0].path}/program/stop`);
assert.equal(stopped.status, 'stopped');
const retained = await request('GET', lights[0].path);
assert.deepEqual(retained.observation.values, first.observation.values);
assert.equal(retained.observation.observed_at, first.observation.observed_at);
assert.equal(retained.observation.freshness, 'stopped');
const denied = await request(
  'POST',
  `${lights[0].path}/actions`,
  { capability: 'light.set_power', parameters: { on: false } },
  422,
  randomUUID(),
);
assert.equal(denied.error.code, 'lab.program_not_running');
const invalid = await request(
  'POST',
  `${lights[1].path}/actions`,
  { capability: 'light.set_brightness', parameters: { brightness: 101 } },
  422,
  randomUUID(),
);
assert.equal(invalid.error.code, 'lab.invalid_parameters');
console.log(
  JSON.stringify(
    {
      lab_id: lab,
      entity_ids: lights.map((light) => light.entity.id),
      run_ids: lights.map((light) => light.run.id),
      command_id: command.id,
      values: lights.map((_, index) =>
        index === 0 ? retained.observation.values : second.observation.values,
      ),
      stopped_source: retained.observation.source,
    },
    null,
    2,
  ),
);
