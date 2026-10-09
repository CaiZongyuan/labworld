import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

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
async function until(path, condition) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const entity = await request('GET', path);
    if (condition(entity)) return entity;
    await setTimeout(100);
  }
  throw new Error(
    'Expected report not received; check source status before restarting',
  );
}
const lab =
  process.env.LAB_ID ??
  (await request('POST', '/labs', { name: 'Temperature tutorial' }, 201)).id;
const sensors = [];
for (const [name, baseline_temperature] of [
  ['Sensor A', 20],
  ['Sensor B', 25],
]) {
  const entity = await request(
    'POST',
    `/labs/${lab}/entities`,
    {
      name,
      definition_id: 'sensor',
      definition_version: '1.0',
      reality: 'simulated',
      configuration: { baseline_temperature },
      representation_id: null,
    },
    201,
  );
  assert.equal(entity.observation, null);
  const path = `/labs/${lab}/entities/${entity.id}`;
  const run = await request('POST', `${path}/program/start`, undefined, 201);
  const measured = await until(
    path,
    (current) => current.observation?.run_id === run.id,
  );
  assert.equal(measured.observation.properties.temperature.unit, 'degC');
  sensors.push({ entity, path, run });
}
const first = sensors[0],
  second = sensors[1];
await request('POST', `${first.path}/program/stop`);
const retained = (await request('GET', first.path)).observation;
const secondSequence = (await request('GET', second.path)).observation.sequence;
const expired = await until(
  first.path,
  (current) =>
    current.observation?.properties.temperature.freshness === 'stale',
);
assert.deepEqual(expired.observation.values, retained.values);
assert.equal(expired.observation.received_at, retained.received_at);
assert(
  (await request('GET', second.path)).observation.sequence > secondSequence,
);
await request(
  'PATCH',
  first.path,
  {
    name: 'Sensor A',
    configuration: {},
    observation: { values: { temperature: 99 } },
  },
  400,
);
assert.deepEqual(
  (await request('GET', first.path)).observation.values,
  retained.values,
);
const resumed = await request(
  'POST',
  `${first.path}/program/start`,
  undefined,
  201,
);
assert.notEqual(resumed.id, first.run.id);
const recovered = await until(
  first.path,
  (current) => current.observation?.run_id === resumed.id,
);
assert.equal(recovered.observation.properties.temperature.freshness, 'current');
assert.notEqual(recovered.observation.received_at, retained.received_at);
console.log(
  JSON.stringify(
    {
      lab_id: lab,
      entity_ids: sensors.map((sensor) => sensor.entity.id),
      retained: expired.observation.properties.temperature,
      recovered: recovered.observation.properties.temperature,
    },
    null,
    2,
  ),
);
