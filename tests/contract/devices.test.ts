import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, expect, test } from 'vitest';
import type {
  DeviceCommand,
  DeviceObservation,
  DeviceProgramRun,
  DeviceTask,
  DeviceTaskResult,
  LabEntity,
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
import { restartTarget } from './target';

let client: HttpClient;
const owned: Array<{ lab: string; id: string }> = [];
const activeTask = (task?: DeviceTask | null) =>
  !!task &&
  ['pending', 'preparing', 'running', 'decelerating'].includes(task.status);

beforeAll(async () => {
  client = await member();
  expect(client.session!.user.role).toBe('member');
});

async function device(
  lab: string,
  definition: string,
  configuration: Record<string, unknown>,
) {
  const entity = await register(client, lab, definition, configuration);
  owned.push({ lab, id: entity.id });
  return entity;
}

const stopProgram = (lab: string, id: string) =>
  client.json<DeviceProgramRun>('POST', `${entityPath(lab, id)}/program/stop`);
const readRun = (lab: string, entity: string, id: string) =>
  client.json<DeviceProgramRun>('GET', `${entityPath(lab, entity)}/runs/${id}`);
const readTask = (lab: string, entity: string, id: string) =>
  client.json<DeviceTask>('GET', `${entityPath(lab, entity)}/tasks/${id}`);
const readResult = (lab: string, entity: string, id: string) =>
  client.json<DeviceTaskResult>(
    'GET',
    `${entityPath(lab, entity)}/results/${id}`,
  );

function observation(entity: LabEntity): DeviceObservation {
  expect(entity.observation).not.toBeNull();
  expect(entity.observation).toBeDefined();
  return entity.observation!;
}

function values(entity: LabEntity) {
  return observation(entity).values as Record<string, unknown>;
}

function timestamp(value: string | null | undefined) {
  expect(typeof value).toBe('string');
  expect(Number.isFinite(Date.parse(value!))).toBe(true);
}

function current(
  entity: LabEntity,
  run: DeviceProgramRun,
  units: Record<string, string | null>,
) {
  const report = observation(entity);
  expect(entity.program_run?.id).toBe(run.id);
  expect(entity.program_run?.status).toBe('running');
  expect(entity.binding?.id).toBe(run.binding_id);
  expect(entity.binding?.source).toBe(run.source);
  expect(report.entity_id).toBe(entity.id);
  expect(report.run_id).toBe(run.id);
  expect(report.source).toBe(run.source);
  expect(report.quality).toBe('good');
  expect(report.freshness).toBe('current');
  timestamp(report.observed_at);
  timestamp(report.received_at);
  for (const [key, unit] of Object.entries(units)) {
    const property = report.properties[key];
    expect(property, `Observed ${key}`).toBeDefined();
    expect(property.binding_id).toBe(run.binding_id);
    expect(property.source).toBe(run.source);
    expect(property.run_id).toBe(run.id);
    expect(property.quality).toBe('good');
    expect(property.freshness).toBe('current');
    expect(property.unit).toBe(unit);
    expect(Number.isInteger(property.sequence)).toBe(true);
    expect(property.sequence).toBeGreaterThan(0);
    timestamp(property.observed_at);
    timestamp(property.received_at);
    timestamp(property.updated_at);
    timestamp(property.expires_at);
    expect(Date.parse(property.expires_at)).toBeGreaterThan(
      Date.parse(property.received_at),
    );
  }
}

async function succeeded(
  actor: HttpClient,
  lab: string,
  entity: string,
  command: DeviceCommand,
) {
  const settled = await settledCommand(actor, lab, entity, command.id);
  expect(settled.status).toBe('succeeded');
  expect(settled.id).toBe(command.id);
  expect(settled.run_id).toBe(command.run_id);
  expect(settled.parameters).toEqual(command.parameters);
  return settled;
}

// A stopped report can still expire later and bump the deployment-wide World version.
// Finish those updates before the following contract file tests unchanged snapshots.
afterEach(async () => {
  const devices = owned.splice(0);
  for (const { lab, id } of devices) {
    const entity = await readEntity(client, lab, id);
    if (entity.program_run?.status !== 'running') continue;
    if (activeTask(entity.task)) {
      const stop = await action(client, lab, id, 'centrifuge.stop', {});
      await succeeded(client, lab, id, stop);
      await until(
        () => readEntity(client, lab, id),
        (value) => !activeTask(value.task),
      );
    }
    await stopProgram(lab, id);
  }
  const labs = [...new Set(devices.map(({ lab }) => lab))];
  await until(
    () => Promise.all(labs.map((lab) => world(client, lab))),
    (worlds) =>
      worlds.every((value) =>
        value.entities.every(
          (entity) =>
            !entity.observation ||
            Object.values(entity.observation.properties).every(
              (property) => property.freshness === 'stale',
            ),
        ),
      ),
    15_000,
    500,
  );
});

// Foundation #4: accepted intent, actual reports, Member/Agent and instance isolation.
test('DEVICE-01 two light programs report actual values independently of accepted Command intent, including zero and false', async () => {
  const lab = await createLab(client, 'Independent lights');
  const a = await device(lab.id, 'light', { on: false, brightness: 70 });
  const b = await device(lab.id, 'light', { on: false, brightness: 20 });
  const { client: agent } = await client.agent();
  expect(a.observation).toBeNull();
  expect(b.observation).toBeNull();
  expect(a.binding?.program_id).toBe('light.v1');
  expect(b.binding?.program_id).toBe('light.v1');
  expect(a.binding?.id).not.toBe(b.binding?.id);
  expect(a.binding?.source).not.toBe(b.binding?.source);
  const runA = await start(client, lab.id, a.id);
  const runB = await start(agent, lab.id, b.id);
  expect(runA.status).toBe('running');
  expect(runB.status).toBe('running');
  expect(runA.id).not.toBe(runB.id);
  expect(runA.configuration).toEqual({ on: false, brightness: 70 });
  expect(runB.configuration).toEqual({ on: false, brightness: 20 });
  expect((await readEntity(client, lab.id, a.id)).observation).toBeNull();
  const onA = await action(client, lab.id, a.id, 'light.set_power', {
    on: true,
  });
  expect(onA.status).toBe('accepted');
  expect(onA.result).toBeNull();
  expect(onA.actor_source).toBe('member');
  expect(onA.actor_id).toBe(client.session!.user.id);
  expect(onA.run_id).toBe(runA.id);
  expect(onA.parameters).toEqual({ on: true });
  expect((await succeeded(client, lab.id, a.id, onA)).result).toEqual({
    meaning: 'applied_by_device_program',
    observation_sequence: 1,
    values: { on: true, brightness: 70 },
  });
  const onB = await action(agent, lab.id, b.id, 'light.set_power', {
    on: true,
  });
  expect(onB.status).toBe('accepted');
  expect(onB.actor_source).toBe('agent');
  expect(onB.actor_id).toBe(client.session!.user.id);
  expect(onB.run_id).toBe(runB.id);
  await succeeded(agent, lab.id, b.id, onB);
  const zero = await action(client, lab.id, a.id, 'light.set_brightness', {
    brightness: 0,
  });
  await succeeded(client, lab.id, a.id, zero);
  const off = await action(client, lab.id, a.id, 'light.set_power', {
    on: false,
  });
  await succeeded(client, lab.id, a.id, off);
  const actualA = await readEntity(client, lab.id, a.id);
  const actualB = await readEntity(agent, lab.id, b.id);
  expect(values(actualA)).toEqual({ on: false, brightness: 0 });
  expect(values(actualB)).toEqual({ on: true, brightness: 20 });
  current(actualA, runA, { on: null, brightness: '%' });
  current(actualB, runB, { on: null, brightness: '%' });
  expect(actualA.observation!.properties.on.value).toBe(false);
  expect(actualA.observation!.properties.brightness.value).toBe(0);
  expect(actualB.observation!.properties.on.value).toBe(true);
  expect(actualB.observation!.properties.brightness.value).toBe(20);
});

// Foundation #4: strict rejections, durable idempotency and explicit recovery.
test('DEVICE-02 light refusals preserve World; duplicate start and same-key retries retain one Run and one Command', async () => {
  const lab = await createLab(client, 'Light command boundaries');
  const entity = await device(lab.id, 'light', { brightness: 70 });
  const { client: agent } = await client.agent();
  const path = entityPath(lab.id, entity.id);
  const beforeStart = await world(client, lab.id);
  for (const actor of [client, agent]) {
    await actor.error(
      'POST',
      `${path}/actions`,
      { capability: 'light.set_power', parameters: { on: true } },
      422,
      'lab.program_not_running',
      { 'idempotency-key': randomUUID() },
    );
  }
  expect(await world(client, lab.id)).toEqual(beforeStart);
  const run = await start(client, lab.id, entity.id);
  const beforeRepeat = await world(client, lab.id);
  expect(
    await client.json<DeviceProgramRun>(
      'POST',
      `${path}/program/start`,
      undefined,
      200,
    ),
  ).toEqual(run);
  expect(await world(client, lab.id)).toEqual(beforeRepeat);
  for (const actor of [client, agent]) {
    const before = await world(client, lab.id);
    await actor.error(
      'POST',
      `${path}/actions`,
      { capability: 'light.set_power', parameters: { on: true } },
      400,
      'idempotency.invalid_key',
    );
    for (const parameters of [
      { brightness: 101 },
      { brightness: '50' },
      { brightness: 50, extra: 1 },
    ]) {
      await actor.error(
        'POST',
        `${path}/actions`,
        { capability: 'light.set_brightness', parameters },
        422,
        'lab.invalid_parameters',
        { 'idempotency-key': randomUUID() },
      );
    }
    expect(await world(client, lab.id)).toEqual(before);
  }
  const key = randomUUID();
  const [first, duplicate] = await Promise.all([
    action(agent, lab.id, entity.id, 'light.set_power', { on: true }, key),
    action(agent, lab.id, entity.id, 'light.set_power', { on: true }, key),
  ]);
  expect(duplicate.id).toBe(first.id);
  expect(first.request_key).toBe(key);
  const settled = await succeeded(agent, lab.id, entity.id, first);
  expect(settled.actor_source).toBe('agent');
  expect(
    await action(
      agent,
      lab.id,
      entity.id,
      'light.set_power',
      { on: true },
      key,
    ),
  ).toEqual(settled);
  const beforeConflict = await world(client, lab.id);
  await agent.error(
    'POST',
    `${path}/actions`,
    { capability: 'light.set_power', parameters: { on: false } },
    409,
    'idempotency.conflict',
    { 'idempotency-key': key },
  );
  expect(await world(client, lab.id)).toEqual(beforeConflict);
  const original = await readEntity(client, lab.id, entity.id);
  expect(values(original)).toEqual({ on: true, brightness: 70 });
  const stoppedRun = await stopProgram(lab.id, entity.id);
  expect(stoppedRun.id).toBe(run.id);
  expect(stoppedRun.status).toBe('stopped');
  timestamp(stoppedRun.ended_at);
  const stopped = await readEntity(client, lab.id, entity.id);
  expect(values(stopped)).toEqual({ on: true, brightness: 70 });
  expect(stopped.observation?.observed_at).toBe(
    original.observation?.observed_at,
  );
  expect(stopped.observation?.received_at).toBe(
    original.observation?.received_at,
  );
  expect(stopped.observation?.freshness).toBe('stopped');
  const stoppedWorld = await world(client, lab.id);
  await client.error(
    'POST',
    `${path}/actions`,
    { capability: 'light.set_power', parameters: { on: false } },
    422,
    'lab.program_not_running',
    { 'idempotency-key': randomUUID() },
  );
  expect(await world(client, lab.id)).toEqual(stoppedWorld);
  const nextRun = await start(client, lab.id, entity.id);
  expect(nextRun.id).not.toBe(run.id);
  const recovered = await action(client, lab.id, entity.id, 'light.set_power', {
    on: false,
  });
  await succeeded(client, lab.id, entity.id, recovered);
  const actual = await readEntity(client, lab.id, entity.id);
  expect(values(actual)).toEqual({ on: false, brightness: 70 });
  current(actual, nextRun, { on: null, brightness: '%' });
});

// Foundation #6: two real 1 Hz programs and per-property provenance.
// Runtime-only partial/duplicate/bad-quality/source-time faults remain #50 supplements.
test('DEVICE-03 independent sensor samples preserve property source, time and quality; Stop retains last values and a new Run recovers', async () => {
  const lab = await createLab(client, 'Independent temperature sources');
  const a = await device(lab.id, 'sensor', { baseline_temperature: 20 });
  const b = await device(lab.id, 'sensor', { baseline_temperature: 25 });
  const { client: agent } = await client.agent();
  expect(a.observation).toBeNull();
  expect(b.observation).toBeNull();
  const runA = await start(client, lab.id, a.id);
  const runB = await start(agent, lab.id, b.id);
  expect(runA.configuration).toEqual({ baseline_temperature: 20 });
  expect(runB.configuration).toEqual({ baseline_temperature: 25 });
  const firstA = await until(
    () => readEntity(client, lab.id, a.id),
    (value) => value.observation?.run_id === runA.id,
  );
  const firstB = await until(
    () => readEntity(agent, lab.id, b.id),
    (value) => value.observation?.run_id === runB.id,
  );
  current(firstA, runA, { temperature: 'degC' });
  current(firstB, runB, { temperature: 'degC' });
  expect(typeof firstA.observation!.properties.temperature.value).toBe(
    'number',
  );
  expect(typeof firstB.observation!.properties.temperature.value).toBe(
    'number',
  );
  // The built-in source varies at most 0.5 degC around each configured baseline.
  expect(values(firstA).temperature).toBeGreaterThanOrEqual(19.5);
  expect(values(firstA).temperature).toBeLessThanOrEqual(20.5);
  expect(values(firstB).temperature).toBeGreaterThanOrEqual(24.5);
  expect(values(firstB).temperature).toBeLessThanOrEqual(25.5);
  expect(firstA.observation!.properties.temperature.value).not.toBe(
    firstB.observation!.properties.temperature.value,
  );
  expect(runA.source).not.toBe(runB.source);
  const nextA = await until(
    () => readEntity(client, lab.id, a.id),
    (value) =>
      (value.observation?.properties.temperature.sequence ?? 0) >
      firstA.observation!.properties.temperature.sequence,
  );
  expect(
    Date.parse(nextA.observation!.properties.temperature.received_at),
  ).toBeGreaterThan(
    Date.parse(firstA.observation!.properties.temperature.received_at),
  );
  await stopProgram(lab.id, a.id);
  await stopProgram(lab.id, b.id);
  const lastA = await readEntity(client, lab.id, a.id);
  const lastB = await readEntity(client, lab.id, b.id);
  const expired = await until(
    () => world(client, lab.id),
    (value) =>
      value.entities.every(
        (entity) =>
          entity.observation?.properties.temperature.freshness === 'stale',
      ),
    15_000,
    500,
  );
  for (const last of [lastA, lastB]) {
    const retained = expired.entities.find((entity) => entity.id === last.id)!;
    expect(retained.program_run?.status).toBe('stopped');
    expect(retained.observation?.values).toEqual(last.observation?.values);
    expect(retained.observation?.properties.temperature.received_at).toBe(
      last.observation?.properties.temperature.received_at,
    );
    expect(retained.observation?.properties.temperature.observed_at).toBe(
      last.observation?.properties.temperature.observed_at,
    );
    expect(retained.observation?.properties.temperature.run_id).toBe(
      last.program_run?.id,
    );
    expect(retained.observation?.freshness).toBe('stale');
  }
  for (const actor of [client, agent]) {
    await actor.error(
      'PATCH',
      entityPath(lab.id, a.id),
      {
        name: a.name,
        configuration: { baseline_temperature: 20 },
        observation: { values: { temperature: 99 } },
      },
      400,
      'http.invalid_json',
    );
  }
  expect(await world(client, lab.id)).toEqual(expired);
  const nextRun = await start(agent, lab.id, a.id);
  expect(nextRun.id).not.toBe(runA.id);
  const recovered = await until(
    () => readEntity(client, lab.id, a.id),
    (value) => value.observation?.run_id === nextRun.id,
  );
  current(recovered, nextRun, { temperature: 'degC' });
  expect(
    Date.parse(recovered.observation!.properties.temperature.received_at),
  ).toBeGreaterThan(
    Date.parse(lastA.observation!.properties.temperature.received_at),
  );
  expect((await readEntity(client, lab.id, b.id)).observation).toEqual(
    expired.entities.find((entity) => entity.id === b.id)!.observation,
  );
});

// Foundation #7: target/actual separation, fixed parameters and completion after idle.
test('DEVICE-04 centrifuge preparation and deceleration do not count toward its six-second Task; completed result is separately queryable', async () => {
  const lab = await createLab(client, 'Centrifuge completion');
  const a = await device(lab.id, 'centrifuge', { initial_temperature: 22 });
  const b = await device(lab.id, 'centrifuge', { initial_temperature: 15 });
  const runA = await start(client, lab.id, a.id);
  const runB = await start(client, lab.id, b.id);
  const parameters = { rpm: 12000, temperature: 14, duration_seconds: 6 };
  const command = await action(
    client,
    lab.id,
    a.id,
    'centrifuge.start',
    parameters,
  );
  expect(command.status).toBe('accepted');
  expect(command.run_id).toBe(runA.id);
  expect(command.parameters).toEqual(parameters);
  expect(command.task_id).toEqual(expect.any(String));
  const started = await succeeded(client, lab.id, a.id, command);
  expect(started.result).toEqual({
    meaning: 'task_started',
    task_id: command.task_id,
  });
  const preparing = await until(
    () => readEntity(client, lab.id, a.id),
    (value) =>
      value.task?.status === 'preparing' &&
      typeof value.observation?.properties.speed.value === 'number' &&
      value.observation.properties.speed.value > 0 &&
      value.observation.properties.speed.value < 12000,
  );
  expect(preparing.task?.elapsed_seconds).toBe(0);
  expect(preparing.task?.timer_started_at).toBeNull();
  expect(preparing.task_result?.status).toBe('pending');
  expect(values(preparing).speed).toBeLessThan(12000);
  expect(values(preparing).speed).toBeGreaterThan(0);
  expect(values(preparing).temperature).toBeGreaterThan(14);
  expect(values(preparing).phase).toBe('preparing');
  await client.json('PATCH', entityPath(lab.id, a.id), {
    name: 'Edited configuration',
    configuration: { initial_temperature: 30 },
  });
  const task = await readTask(lab.id, a.id, command.task_id!);
  expect(task.id).toBe(command.task_id);
  expect(task.command_id).toBe(command.id);
  expect(task.run_id).toBe(runA.id);
  expect(task.entity_id).toBe(a.id);
  expect(task.parameters).toEqual(parameters);
  expect((await readRun(lab.id, a.id, runA.id)).configuration).toEqual({
    initial_temperature: 22,
  });
  const running = await until(
    () => readEntity(client, lab.id, a.id),
    (value) => value.task?.status === 'running',
  );
  // #7 and the public program definition: timing begins within these tolerances.
  const assertRunningTolerance = (speed: unknown, temperature: unknown) => {
    expect(speed).toBeGreaterThanOrEqual(11950);
    expect(speed).toBeLessThanOrEqual(12050);
    expect(temperature).toBeGreaterThanOrEqual(13.5);
    expect(temperature).toBeLessThanOrEqual(14.5);
  };
  assertRunningTolerance(values(running).speed, values(running).temperature);
  expect(() => assertRunningTolerance(11949, 14)).toThrow();
  expect(() => assertRunningTolerance(12000, 14.6)).toThrow();
  timestamp(running.task?.timer_started_at);
  expect(running.task?.elapsed_seconds).toBeLessThan(6);
  const slowing = await until(
    () => readEntity(client, lab.id, a.id),
    (value) => value.task?.status === 'decelerating',
  );
  expect(slowing.task?.elapsed_seconds).toBe(6);
  expect(slowing.task_result?.status).toBe('pending');
  expect(values(slowing).speed).toBeGreaterThan(0);
  const completed = await until(
    () => readEntity(client, lab.id, a.id),
    (value) => value.task?.status === 'completed',
  );
  expect(completed.task?.id).toBe(command.task_id);
  expect(completed.task?.parameters).toEqual(parameters);
  expect(completed.task?.elapsed_seconds).toBe(6);
  timestamp(completed.task?.ended_at);
  expect(values(completed)).toEqual({
    speed: 0,
    temperature: 14,
    phase: 'idle',
    elapsed_seconds: 6,
  });
  current(completed, runA, {
    speed: 'rpm',
    temperature: 'degC',
    phase: null,
    elapsed_seconds: 's',
  });
  const result = await readResult(lab.id, a.id, task.result_id);
  expect(result.id).toBe(task.result_id);
  expect(result.task_id).toBe(task.id);
  expect(result.status).toBe('completed');
  expect(result.reason).toBeNull();
  timestamp(result.ended_at);
  expect(completed.task_result).toEqual(result);
  expect(await readTask(lab.id, a.id, task.id)).toEqual(completed.task);
  const other = await readEntity(client, lab.id, b.id);
  expect(other.task).toBeNull();
  expect(values(other)).toEqual({
    speed: 0,
    temperature: 15,
    phase: 'idle',
    elapsed_seconds: 0,
  });
  current(other, runB, {
    speed: 'rpm',
    temperature: 'degC',
    phase: null,
    elapsed_seconds: 's',
  });
  await client.error(
    'GET',
    `${entityPath(lab.id, b.id)}/results/${result.id}`,
    undefined,
    404,
    'lab.world_not_found',
  );
  expect(await readResult(lab.id, a.id, result.id)).toEqual(result);
});

// Foundation #7: busy rejection, Stop Task, Stop Run and two active instances.
test('DEVICE-05 busy Start and Stop Run preserve active Task; Stop Task cancels only its instance and permits a fresh Task in the same Run', async () => {
  const lab = await createLab(client, 'Centrifuge cancellation');
  const a = await device(lab.id, 'centrifuge', { initial_temperature: 22 });
  const b = await device(lab.id, 'centrifuge', { initial_temperature: 15 });
  const runA = await start(client, lab.id, a.id);
  const runB = await start(client, lab.id, b.id);
  const { client: agent } = await client.agent();
  const parametersA = { rpm: 12000, temperature: 22, duration_seconds: 6 };
  const parametersB = { rpm: 6000, temperature: 15, duration_seconds: 6 };
  const key = randomUUID();
  const commandA = await action(
    client,
    lab.id,
    a.id,
    'centrifuge.start',
    parametersA,
    key,
  );
  const commandB = await action(
    agent,
    lab.id,
    b.id,
    'centrifuge.start',
    parametersB,
  );
  await succeeded(client, lab.id, a.id, commandA);
  await succeeded(agent, lab.id, b.id, commandB);
  const before = await until(
    () => readEntity(client, lab.id, a.id),
    (value) =>
      value.task?.status === 'preparing' &&
      typeof value.observation?.properties.speed.value === 'number' &&
      value.observation.properties.speed.value > 0,
  );
  expect(before.task?.parameters).toEqual(parametersA);
  const retry = await action(
    client,
    lab.id,
    a.id,
    'centrifuge.start',
    parametersA,
    key,
  );
  expect(retry.id).toBe(commandA.id);
  expect(retry.task_id).toBe(commandA.task_id);
  const path = entityPath(lab.id, a.id);
  for (const actor of [client, agent]) {
    await actor.error(
      'POST',
      `${path}/actions`,
      { capability: 'centrifuge.start', parameters: parametersA },
      409,
      'lab.device_busy',
      { 'idempotency-key': randomUUID() },
    );
    await actor.error(
      'POST',
      `${path}/program/stop`,
      undefined,
      409,
      'lab.device_busy',
    );
  }
  await client.error(
    'POST',
    `${path}/actions`,
    {
      capability: 'centrifuge.start',
      parameters: { ...parametersA, duration_seconds: 5 },
    },
    422,
    'lab.invalid_parameters',
    { 'idempotency-key': randomUUID() },
  );
  const unchanged = await world(client, lab.id);
  const active = unchanged.entities.find((entity) => entity.id === a.id)!;
  expect(active.program_run?.id).toBe(runA.id);
  expect(active.program_run?.status).toBe('running');
  expect(active.task?.id).toBe(commandA.task_id);
  expect(active.task?.parameters).toEqual(parametersA);
  expect(active.task_result?.id).toBe(before.task_result?.id);
  expect(active.task_result?.status).toBe('pending');
  expect((await readRun(lab.id, a.id, runA.id)).status).toBe('running');
  expect((await readTask(lab.id, a.id, commandA.task_id!)).parameters).toEqual(
    parametersA,
  );
  const stop = await action(agent, lab.id, a.id, 'centrifuge.stop', {});
  expect(stop.task_id).toBe(commandA.task_id);
  expect((await succeeded(agent, lab.id, a.id, stop)).result).toEqual({
    meaning: 'deceleration_requested',
    task_id: commandA.task_id,
  });
  const slowing = await until(
    () => readEntity(client, lab.id, a.id),
    (value) => value.task?.status === 'decelerating',
  );
  expect(slowing.task_result?.status).toBe('pending');
  expect(values(slowing).phase).toBe('decelerating');
  expect(values(slowing).speed).toBeGreaterThan(0);
  const other = await readEntity(agent, lab.id, b.id);
  expect(other.task?.id).toBe(commandB.task_id);
  expect(other.task?.parameters).toEqual(parametersB);
  expect(other.program_run?.id).toBe(runB.id);
  expect(other.program_run?.status).toBe('running');
  expect(other.task_result?.status).toBe('pending');
  const cancelled = await until(
    () => readEntity(client, lab.id, a.id),
    (value) => value.task?.status === 'cancelled',
  );
  expect(values(cancelled).speed).toBe(0);
  expect(values(cancelled).phase).toBe('idle');
  expect(cancelled.task?.elapsed_seconds).toBeLessThan(6);
  expect(cancelled.program_run?.id).toBe(runA.id);
  expect(cancelled.program_run?.status).toBe('running');
  const result = await readResult(lab.id, a.id, cancelled.task!.result_id);
  expect(result.task_id).toBe(commandA.task_id);
  expect(result.status).toBe('cancelled');
  timestamp(result.ended_at);
  const completedB = await until(
    () => readEntity(agent, lab.id, b.id),
    (value) => value.task?.status === 'completed',
  );
  expect(completedB.task_result?.status).toBe('completed');
  expect(values(completedB)).toEqual({
    speed: 0,
    temperature: 15,
    phase: 'idle',
    elapsed_seconds: 6,
  });
  const next = await action(client, lab.id, a.id, 'centrifuge.start', {
    rpm: 500,
    temperature: 22,
    duration_seconds: 6,
  });
  expect(next.run_id).toBe(runA.id);
  expect(next.task_id).not.toBe(commandA.task_id);
  await succeeded(client, lab.id, a.id, next);
  const cancelNext = await action(client, lab.id, a.id, 'centrifuge.stop', {});
  await succeeded(client, lab.id, a.id, cancelNext);
  await until(
    () => readTask(lab.id, a.id, next.task_id!),
    (value) => value.status === 'cancelled',
  );
  expect(await readResult(lab.id, a.id, result.id)).toEqual(result);
  expect((await stopProgram(lab.id, a.id)).status).toBe('stopped');
  expect((await readTask(lab.id, a.id, commandA.task_id!)).status).toBe(
    'cancelled',
  );
  expect(await readResult(lab.id, a.id, result.id)).toEqual(result);
});

// Foundation #4/#6/#7 and ADR 0006: genuine owned-process restart, no replay.
test('DEVICE-06 real API restart interrupts old Run and unfinished Task, retains completed results and requires explicit recovery without command replay', async () => {
  const lab = await createLab(client, 'Interrupted device programs');
  const light = await device(lab.id, 'light', { on: false, brightness: 70 });
  const sensor = await device(lab.id, 'sensor', { baseline_temperature: 20 });
  const centrifuge = await device(lab.id, 'centrifuge', {
    initial_temperature: 20,
  });
  const lightRun = await start(client, lab.id, light.id);
  const sensorRun = await start(client, lab.id, sensor.id);
  const centrifugeRun = await start(client, lab.id, centrifuge.id);
  const lightKey = randomUUID();
  const lightCommand = await action(
    client,
    lab.id,
    light.id,
    'light.set_power',
    { on: true },
    lightKey,
  );
  const committedLight = await succeeded(
    client,
    lab.id,
    light.id,
    lightCommand,
  );
  const completedCommand = await action(
    client,
    lab.id,
    centrifuge.id,
    'centrifuge.start',
    { rpm: 500, temperature: 20, duration_seconds: 6 },
  );
  await succeeded(client, lab.id, centrifuge.id, completedCommand);
  const completed = await until(
    () => readEntity(client, lab.id, centrifuge.id),
    (value) => value.task?.status === 'completed',
  );
  const completedResult = await readResult(
    lab.id,
    centrifuge.id,
    completed.task!.result_id,
  );
  expect(completedResult.status).toBe('completed');
  const parameters = { rpm: 12000, temperature: 10, duration_seconds: 6 };
  const taskKey = randomUUID();
  const unfinishedCommand = await action(
    client,
    lab.id,
    centrifuge.id,
    'centrifuge.start',
    parameters,
    taskKey,
  );
  const committedTaskStart = await succeeded(
    client,
    lab.id,
    centrifuge.id,
    unfinishedCommand,
  );
  const before = await until(
    () => readEntity(client, lab.id, centrifuge.id),
    (value) => value.task?.status === 'preparing',
  );
  const lightBefore = await readEntity(client, lab.id, light.id);
  const sensorBefore = await readEntity(client, lab.id, sensor.id);
  current(sensorBefore, sensorRun, { temperature: 'degC' });
  const restarted = await restartTarget();
  const restartFinished = Date.now();
  expect(restarted.newPid).not.toBe(restarted.oldPid);
  const interrupted = await until(
    () => readEntity(client, lab.id, centrifuge.id),
    (value) => value.program_run?.status === 'interrupted',
  );
  expect(interrupted.id).toBe(centrifuge.id);
  expect(interrupted.configuration).toEqual({ initial_temperature: 20 });
  expect(interrupted.binding).toEqual(centrifuge.binding);
  expect(interrupted.program_run?.id).toBe(centrifugeRun.id);
  expect(interrupted.task?.id).toBe(unfinishedCommand.task_id);
  expect(interrupted.task?.status).toBe('interrupted');
  expect(interrupted.task?.parameters).toEqual(parameters);
  expect(interrupted.task_result?.id).toBe(before.task?.result_id);
  expect(interrupted.task_result?.task_id).toBe(unfinishedCommand.task_id);
  expect(interrupted.task_result?.status).toBe('interrupted');
  expect(interrupted.task_result?.reason).toBe('runtime_interrupted');
  expect(interrupted.observation?.run_id).toBe(centrifugeRun.id);
  expect(values(interrupted).phase).toBe('preparing');
  expect(Date.parse(interrupted.observation!.received_at)).toBeLessThanOrEqual(
    restartFinished,
  );
  expect(await readResult(lab.id, centrifuge.id, completedResult.id)).toEqual(
    completedResult,
  );
  expect(
    (await readTask(lab.id, centrifuge.id, completedCommand.task_id!)).status,
  ).toBe('completed');
  expect(
    await action(
      client,
      lab.id,
      centrifuge.id,
      'centrifuge.start',
      parameters,
      taskKey,
    ),
  ).toEqual(committedTaskStart);
  const retainedLight = await readEntity(client, lab.id, light.id);
  const retainedSensor = await readEntity(client, lab.id, sensor.id);
  expect(retainedLight.program_run?.id).toBe(lightRun.id);
  expect(retainedLight.program_run?.status).toBe('interrupted');
  expect(values(retainedLight)).toEqual({ on: true, brightness: 70 });
  expect(retainedLight.observation?.properties).toEqual(
    lightBefore.observation?.properties,
  );
  expect(retainedSensor.program_run?.id).toBe(sensorRun.id);
  expect(retainedSensor.program_run?.status).toBe('interrupted');
  expect(retainedSensor.binding).toEqual(sensor.binding);
  expect(retainedSensor.observation?.properties.temperature.run_id).toBe(
    sensorRun.id,
  );
  expect(
    Date.parse(retainedSensor.observation!.properties.temperature.received_at),
  ).toBeGreaterThanOrEqual(
    Date.parse(sensorBefore.observation!.properties.temperature.received_at),
  );
  expect(
    Date.parse(retainedSensor.observation!.properties.temperature.received_at),
  ).toBeLessThanOrEqual(restartFinished);
  for (const [entity, run] of [
    [light, lightRun],
    [sensor, sensorRun],
    [centrifuge, centrifugeRun],
  ] as const) {
    expect((await readRun(lab.id, entity.id, run.id)).status).toBe(
      'interrupted',
    );
  }
  await until(
    () => world(client, lab.id),
    (value) =>
      value.entities.every((entity) =>
        Object.values(entity.observation!.properties).every(
          (property) => property.freshness === 'stale',
        ),
      ),
    15_000,
    500,
  );
  const quietWorld = await world(client, lab.id);
  await client.error(
    'POST',
    `${entityPath(lab.id, light.id)}/actions`,
    { capability: 'light.set_power', parameters: { on: false } },
    422,
    'lab.program_not_running',
    { 'idempotency-key': randomUUID() },
  );
  expect(await world(client, lab.id)).toEqual(quietWorld);
  expect(
    await action(
      client,
      lab.id,
      light.id,
      'light.set_power',
      { on: true },
      lightKey,
    ),
  ).toEqual(committedLight);
  expect(await world(client, lab.id)).toEqual(quietWorld);
  expect(
    (await readEntity(client, lab.id, sensor.id)).observation?.properties
      .temperature.received_at,
  ).toBe(retainedSensor.observation?.properties.temperature.received_at);
  expect(
    (await readEntity(client, lab.id, centrifuge.id)).observation?.values,
  ).toEqual(interrupted.observation?.values);
  const newLightRun = await start(client, lab.id, light.id);
  expect(newLightRun.id).not.toBe(lightRun.id);
  const newOff = await action(client, lab.id, light.id, 'light.set_power', {
    on: false,
  });
  await succeeded(client, lab.id, light.id, newOff);
  const newActual = await readEntity(client, lab.id, light.id);
  current(newActual, newLightRun, { on: null, brightness: '%' });
  expect(values(newActual)).toEqual({ on: false, brightness: 70 });
  expect(
    await action(
      client,
      lab.id,
      light.id,
      'light.set_power',
      { on: true },
      lightKey,
    ),
  ).toEqual(committedLight);
  expect((await readEntity(client, lab.id, light.id)).observation).toEqual(
    newActual.observation,
  );
  const newSensorRun = await start(client, lab.id, sensor.id);
  expect(newSensorRun.id).not.toBe(sensorRun.id);
  const newMeasurement = await until(
    () => readEntity(client, lab.id, sensor.id),
    (value) => value.observation?.run_id === newSensorRun.id,
  );
  current(newMeasurement, newSensorRun, { temperature: 'degC' });
  const newCentrifugeRun = await start(client, lab.id, centrifuge.id);
  expect(newCentrifugeRun.id).not.toBe(centrifugeRun.id);
  const idle = await until(
    () => readEntity(client, lab.id, centrifuge.id),
    (value) => value.observation?.run_id === newCentrifugeRun.id,
  );
  expect(values(idle)).toEqual({
    speed: 0,
    temperature: 20,
    phase: 'idle',
    elapsed_seconds: 0,
  });
  expect(idle.task?.id).toBe(unfinishedCommand.task_id);
  expect(idle.task_result?.status).toBe('interrupted');
  expect(await readResult(lab.id, centrifuge.id, completedResult.id)).toEqual(
    completedResult,
  );
});
