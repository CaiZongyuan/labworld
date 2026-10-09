import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const key = process.env.LAB_API_KEY;
if (!key) throw new Error('Set LAB_API_KEY to an active lab:full credential');
async function request(method, path, body, expected = 200, requestKey) {
  const response = await fetch(`${base}/api/v1/lab${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(requestKey ? { 'Idempotency-Key': requestKey } : {}),
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
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const entity = await request('GET', path);
    if (condition(entity)) return entity;
    await setTimeout(100);
  }
  throw new Error(
    'Task deadline reached; query its result before sending a new command',
  );
}
const lab =
  process.env.LAB_ID ??
  (await request('POST', '/labs', { name: 'Centrifuge tutorial' }, 201)).id;
const devices = [];
for (const name of ['Tutorial centrifuge A', 'Tutorial centrifuge B']) {
  const entity = await request(
    'POST',
    `/labs/${lab}/entities`,
    {
      name,
      definition_id: 'centrifuge',
      definition_version: '1.0',
      reality: 'simulated',
      configuration: { initial_temperature: 22 },
      representation_id: null,
    },
    201,
  );
  const path = `/labs/${lab}/entities/${entity.id}`;
  const run = await request('POST', `${path}/program/start`, undefined, 201);
  devices.push({ entity, path, run });
}
const start = {
  capability: 'centrifuge.start',
  parameters: { rpm: 6000, temperature: 22, duration_seconds: 6 },
};
const requestKey = crypto.randomUUID();
const command = await request(
  'POST',
  `${devices[0].path}/actions`,
  start,
  202,
  requestKey,
);
const retry = await request(
  'POST',
  `${devices[0].path}/actions`,
  start,
  202,
  requestKey,
);
assert.equal(retry.id, command.id);
assert.equal(retry.task_id, command.task_id);
await request(
  'POST',
  `${devices[0].path}/actions`,
  start,
  409,
  crypto.randomUUID(),
);
const second = await request(
  'POST',
  `${devices[1].path}/actions`,
  {
    capability: 'centrifuge.start',
    parameters: { rpm: 6000, temperature: 22, duration_seconds: 60 },
  },
  202,
  crypto.randomUUID(),
);
await until(devices[1].path, (entity) => entity.observation?.values.speed > 0);
await request(
  'POST',
  `${devices[1].path}/actions`,
  { capability: 'centrifuge.stop', parameters: {} },
  202,
  crypto.randomUUID(),
);
const cancelled = await until(
  devices[1].path,
  (entity) => entity.task_result?.status === 'cancelled',
);
const completed = await until(
  devices[0].path,
  (entity) => entity.task_result?.status === 'completed',
);
for (const [device, current, startCommand] of [
  [devices[0], completed, command],
  [devices[1], cancelled, second],
]) {
  const task = await request(
    'GET',
    `${device.path}/tasks/${startCommand.task_id}`,
  );
  const result = await request(
    'GET',
    `${device.path}/results/${task.result_id}`,
  );
  const accepted = await request(
    'GET',
    `${device.path}/commands/${startCommand.id}`,
  );
  const run = await request('GET', `${device.path}/runs/${device.run.id}`);
  assert.equal(accepted.status, 'succeeded');
  assert.equal(run.status, 'running');
  assert.equal(task.status, result.status);
  assert.equal(current.observation.values.speed, 0);
  assert.equal(current.observation.values.phase, 'idle');
  assert.notEqual(task.id, run.id);
  assert.notEqual(task.id, result.id);
}
assert.equal(completed.task.elapsed_seconds, 6);
assert(cancelled.task.elapsed_seconds < 60);
console.log(
  JSON.stringify(
    {
      lab_id: lab,
      devices: devices.map((device, index) => ({
        entity_id: device.entity.id,
        run_id: device.run.id,
        command_id: index === 0 ? command.id : second.id,
        task_id: index === 0 ? completed.task.id : cancelled.task.id,
        result_id:
          index === 0 ? completed.task.result_id : cancelled.task.result_id,
        status: index === 0 ? 'completed' : 'cancelled',
      })),
    },
    null,
    2,
  ),
);
