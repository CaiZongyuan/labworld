import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test } from 'vitest';
import type {
  DeviceTask,
  DeviceTaskResult,
  HistoryPage,
  HistoryCleanup,
  RetentionPolicy,
} from '../../packages/contracts/src/generated/types.gen';
import { HttpClient, member, until } from './http';
import {
  action,
  createLab,
  entityPath,
  readEntity,
  register,
  settledCommand,
  start,
  world,
} from './lab';
let client: HttpClient;
beforeAll(async () => {
  client = await member();
});
const stale = (lab: string, id: string) =>
  until(
    () => readEntity(client, lab, id),
    (entity) =>
      Object.values(entity.observation?.properties ?? {}).every(
        (property) => property.freshness === 'stale',
      ),
  );
const cleanup = (lab: string) =>
  client.json<HistoryCleanup>(
    'POST',
    `/api/v1/lab/labs/${lab}/history/cleanup`,
  );

test('RETENTION-01 configured cleanup removes expired ended history, preserves last Observation and unfinished Task, and reports real gaps', async () => {
  const lab = (await createLab(client, 'Short retention')).id;
  expect(
    await client.json<RetentionPolicy>(
      'GET',
      `/api/v1/lab/labs/${lab}/history/retention`,
    ),
  ).toEqual({ observation_seconds: 2, record_seconds: 3 });
  const sensor = await register(client, lab, 'sensor');
  await start(client, lab, sensor.id);
  await until(
    () => readEntity(client, lab, sensor.id),
    (entity) => (entity.observation?.sequence ?? 0) >= 2,
  );
  await client.json('POST', `${entityPath(lab, sensor.id)}/program/stop`);
  const stopped = await readEntity(client, lab, sensor.id);
  const short = await register(client, lab, 'centrifuge', {
    initial_temperature: 22,
  });
  await start(client, lab, short.id);
  const shortCommand = await action(client, lab, short.id, 'centrifuge.start', {
    rpm: 500,
    temperature: 22,
    duration_seconds: 6,
  });
  const long = await register(client, lab, 'centrifuge', {
    initial_temperature: 22,
  });
  await start(client, lab, long.id);
  const longCommand = await action(client, lab, long.id, 'centrifuge.start', {
    rpm: 500,
    temperature: 22,
    duration_seconds: 60,
  });
  try {
    const completed = await until(
      () => readEntity(client, lab, short.id),
      (entity) => entity.task_result?.status === 'completed',
      20_000,
    );
    const endedAt = Date.parse(completed.task_result!.ended_at!);
    await until(
      async () => Date.now(),
      (now) => now > endedAt + 3100,
    );
    const resultPath = `${entityPath(lab, short.id)}/results/${completed.task_result!.id}`;
    expect(
      (await client.json<DeviceTaskResult>('GET', resultPath)).status,
    ).toBe('completed');
    await client.error(
      'POST',
      `/api/v1/lab/labs/${lab}/history/cleanup`,
      undefined,
      403,
      undefined,
      { 'x-csrf-token': '' },
    );
    expect((await client.json<DeviceTaskResult>('GET', resultPath)).id).toBe(
      completed.task_result!.id,
    );
    const removed = await cleanup(lab);
    expect(removed.observations).toBeGreaterThan(0);
    expect(removed.tasks).toBeGreaterThan(0);
    expect(removed.commands).toBeGreaterThan(0);
    await client.error('GET', resultPath, undefined, 404);
    await client.error(
      'GET',
      `${entityPath(lab, short.id)}/tasks/${shortCommand.task_id}`,
      undefined,
      404,
    );
    const current = await readEntity(client, lab, sensor.id);
    expect(current.id).toBe(stopped.id);
    expect(current.configuration).toEqual(stopped.configuration);
    expect(current.observation!.values).toEqual(stopped.observation!.values);
    expect(current.observation!.received_at).toBe(
      stopped.observation!.received_at,
    );
    const ongoing = await client.json<DeviceTask>(
      'GET',
      `${entityPath(lab, long.id)}/tasks/${longCommand.task_id}`,
    );
    expect(ongoing.ended_at).toBeNull();
    expect(ongoing.status).not.toBe('interrupted');
    const from = new Date(Date.now() - 60_000).toISOString(),
      to = new Date(Date.now() + 1000).toISOString();
    const history = await client.json<HistoryPage>(
      'GET',
      `${entityPath(lab, sensor.id)}/history?${new URLSearchParams({ record_type: 'observation', from, to })}`,
    );
    expect(history.gap).toBe(true);
    expect(history.items).toHaveLength(0);
    expect(Date.parse(history.available_since)).toBeGreaterThan(
      Date.parse(from),
    );
    const newRun = await start(client, lab, sensor.id);
    await until(
      () => readEntity(client, lab, sensor.id),
      (entity) => entity.observation?.run_id === newRun.id,
    );
    expect(
      (await readEntity(client, lab, sensor.id)).observation!.received_at,
    ).not.toBe(stopped.observation!.received_at);
  } finally {
    await action(client, lab, long.id, 'centrifuge.stop', {});
    await until(
      () => readEntity(client, lab, long.id),
      (entity) => entity.task_result?.status === 'cancelled',
      15_000,
    );
    for (const id of [sensor.id, short.id, long.id]) {
      await client.json('POST', `${entityPath(lab, id)}/program/stop`);
      await stale(lab, id);
    }
  }
});

test('RETENTION-02 expired durable Command receipt cannot replay after cleanup, stop or archive; changed parameters conflict and a new action recovers', async () => {
  const lab = (await createLab(client, 'Receipt expiration')).id;
  const light = await register(client, lab, 'light');
  await start(client, lab, light.id);
  const key = randomUUID(),
    parameters = { on: true };
  const command = await action(
    client,
    lab,
    light.id,
    'light.set_power',
    parameters,
    key,
  );
  expect((await settledCommand(client, lab, light.id, command.id)).status).toBe(
    'succeeded',
  );
  await client.json('POST', `${entityPath(lab, light.id)}/program/stop`);
  await stale(lab, light.id);
  await cleanup(lab);
  await client.error(
    'GET',
    `${entityPath(lab, light.id)}/commands/${command.id}`,
    undefined,
    404,
  );
  const before = await world(client, lab);
  const path = `${entityPath(lab, light.id)}/actions`;
  await client.error(
    'POST',
    path,
    { capability: 'light.set_power', parameters },
    410,
    'lab.command_expired',
    { 'idempotency-key': key },
  );
  await client.error(
    'POST',
    path,
    { capability: 'light.set_power', parameters: { on: false } },
    409,
    'idempotency.conflict',
    { 'idempotency-key': key },
  );
  expect(await world(client, lab)).toEqual(before);
  await start(client, lab, light.id);
  const recovered = await action(client, lab, light.id, 'light.set_power', {
    on: false,
  });
  expect(recovered.id).not.toBe(command.id);
  expect(
    (await settledCommand(client, lab, light.id, recovered.id)).status,
  ).toBe('succeeded');
  await client.json('POST', `${entityPath(lab, light.id)}/program/stop`);
  await client.json('POST', `${entityPath(lab, light.id)}/archive`);
  await stale(lab, light.id);
  const archived = await world(client, lab);
  await client.error(
    'POST',
    path,
    { capability: 'light.set_power', parameters },
    410,
    'lab.command_expired',
    { 'idempotency-key': key },
  );
  expect(await world(client, lab)).toEqual(archived);
});
