import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  PersistentLab,
  LabEntity,
  DeviceProgramRun,
  DeviceTask,
  DeviceTaskResult,
  DeviceCommand,
  HistoryCleanup,
  HistoryPage,
  RetentionPolicy,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

// Keep public observation below the normal request budget. Unexpected HTTP
// failures propagate immediately rather than becoming a condition timeout.
async function poll<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 30_000,
  intervalMs = 250,
) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  throw new Error('Public history condition timed out');
}

async function prepareHistory(target: ServerProcess, owner: string) {
  const client = new CoreHttp(target.url);
  await client.register(`${owner}@example.test`);
  const lab = await client.json<PersistentLab>(
    'POST',
    '/api/v1/lab/labs',
    { name: `${owner} history` },
    201,
  );
  const labPath = `/api/v1/lab/labs/${lab.id}`;
  assert.deepEqual(
    await client.json<RetentionPolicy>('GET', labPath + '/history/retention'),
    { observation_seconds: 2, record_seconds: 20 },
  );
  async function centrifuge() {
    const entity = await client.json<LabEntity>(
      'POST',
      labPath + '/entities',
      {
        name: 'History centrifuge',
        definition_id: 'centrifuge',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: { initial_temperature: 22 },
        representation_id: null,
      },
      201,
    );
    const path = `${labPath}/entities/${entity.id}`;
    const run = await client.json<DeviceProgramRun>(
      'POST',
      path + '/program/start',
      undefined,
      201,
    );
    return { path, run };
  }
  const short = await centrifuge(),
    key = randomUUID(),
    parameters = { rpm: 500, temperature: 22, duration_seconds: 6 },
    command = await client.json<DeviceCommand>(
      'POST',
      short.path + '/actions',
      { capability: 'centrifuge.start', parameters },
      202,
      { 'idempotency-key': key },
    ),
    active = await centrifuge(),
    activeCommand = await client.json<DeviceCommand>(
      'POST',
      active.path + '/actions',
      {
        capability: 'centrifuge.start',
        parameters: { rpm: 500, temperature: 22, duration_seconds: 180 },
      },
      202,
      { 'idempotency-key': randomUUID() },
    );
  const completed = await poll(
    () => client.json<LabEntity>('GET', short.path),
    (entity) => entity.task_result?.status === 'completed',
    20_000,
  );
  assert.ok(completed.task_result?.ended_at);
  await client.json('POST', short.path + '/program/stop');
  const retained = await poll(
    () => client.json<LabEntity>('GET', short.path),
    (entity) =>
      Object.values(entity.observation?.properties ?? {}).every(
        (property) => property.freshness === 'stale',
      ),
  );
  assert.ok(retained.observation);
  const paths = [
    short.path + `/tasks/${command.task_id}`,
    short.path + `/results/${completed.task_result.id}`,
    short.path + `/commands/${command.id}`,
  ];
  assert.equal(
    (await client.json<DeviceTask>('GET', paths[0])).id,
    command.task_id,
  );
  assert.equal(
    (await client.json<DeviceTaskResult>('GET', paths[1])).id,
    completed.task_result.id,
  );
  assert.equal(
    (await client.json<DeviceCommand>('GET', paths[2])).id,
    command.id,
  );
  console.log(
    JSON.stringify({
      event: 'history.ownership',
      owner,
      stage: 'present',
      at: new Date().toISOString(),
      task_id: command.task_id,
      result_id: completed.task_result.id,
      command_id: command.id,
      ended_at: completed.task_result.ended_at,
      statuses: [200, 200, 200],
    }),
  );
  return {
    owner,
    client,
    labPath,
    short,
    active,
    activeCommand,
    retained,
    paths,
    key,
    parameters,
  };
}

async function assertRetained(
  fixture: Awaited<ReturnType<typeof prepareHistory>>,
) {
  const { client, short, active, activeCommand, retained, key, parameters } =
    fixture;
  const current = await client.json<LabEntity>('GET', short.path);
  assert.equal(current.id, retained.id);
  assert.deepEqual(current.configuration, retained.configuration);
  assert.deepEqual(current.observation?.values, retained.observation!.values);
  assert.equal(
    current.observation?.received_at,
    retained.observation!.received_at,
  );
  const task = await client.json<DeviceTask>(
      'GET',
      active.path + `/tasks/${activeCommand.task_id}`,
    ),
    run = await client.json<DeviceProgramRun>(
      'GET',
      active.path + `/runs/${active.run.id}`,
    );
  assert.equal(task.ended_at, null);
  assert.notEqual(task.status, 'interrupted');
  assert.equal(run.status, 'running');
  assert.equal(run.ended_at, null);
  await client.error(
    'POST',
    short.path + '/actions',
    { capability: 'centrifuge.start', parameters },
    410,
    'lab.command_expired',
    { 'idempotency-key': key },
  );
  await client.error(
    'POST',
    short.path + '/actions',
    { capability: 'centrifuge.start', parameters: { ...parameters, rpm: 600 } },
    409,
    'idempotency.conflict',
    { 'idempotency-key': key },
  );
  // The active device continues to sample; refusal must preserve the stopped one.
  const refused = await client.json<LabEntity>('GET', short.path);
  assert.deepEqual(refused, current);
  const from = new Date(
      Date.parse(retained.observation!.received_at) - 1000,
    ).toISOString(),
    to = new Date(Date.now() + 1000).toISOString(),
    history = await client.json<HistoryPage>(
      'GET',
      short.path +
        '/history?' +
        new URLSearchParams({ record_type: 'observation', from, to }),
    );
  assert.equal(history.gap, true);
  assert.deepEqual(history.items, []);
  assert.ok(Date.parse(history.available_since) > Date.parse(from));
}

test(
  'automatic history cleanup precedes a zero manual count; manual fixture retains deletion ownership',
  { timeout: 150_000 },
  async () => {
    const targets: ServerProcess[] = [];
    let cleanupFailure: AggregateError | undefined;
    try {
      for (const entry of [
        'apps/server/src/main.ts',
        'tests/support/history-manual-cleanup-process.ts',
      ]) {
        const target = await new ServerProcess().create();
        targets.push(target);
        target.entry = entry;
        target.env = {
          APP_ORIGIN: target.url,
          LAB_OBSERVATION_RETENTION_SECS: '2',
          LAB_RECORD_RETENTION_SECS: '20',
        };
        await target.start();
      }
      const automatic = await prepareHistory(targets[0], 'automatic-owner'),
        manual = await prepareHistory(targets[1], 'manual-owner');
      // No cleanup or archive request precedes this observation. Use the real
      // production scheduler and public persisted-record responses, not a test tick.
      const gone = await poll(
        async () => {
          const statuses = [];
          for (const path of automatic.paths) {
            const response = await automatic.client.response('GET', path);
            statuses.push(response.status);
            await response.arrayBuffer();
            if (![200, 404].includes(response.status))
              assert.fail(
                `GET ${path} returned unexpected HTTP ${response.status}`,
              );
          }
          return statuses;
        },
        (statuses) => statuses.every((status) => status === 404),
        125_000,
        1000,
      );
      console.log(
        JSON.stringify({
          event: 'history.ownership',
          owner: automatic.owner,
          stage: 'automatically-removed',
          at: new Date().toISOString(),
          statuses: gone,
        }),
      );
      for (const fixture of [automatic, manual]) {
        const { client, owner } = fixture;
        if (fixture === manual) {
          assert.ok(
            Date.now() - Date.parse(manual.retained.task_result!.ended_at!) >
              20_000,
          );
          for (const path of manual.paths) await client.json('GET', path);
        }
        const removed = await client.json<HistoryCleanup>(
          'POST',
          fixture.labPath + '/history/cleanup',
        );
        assert.equal(removed.tasks, fixture === automatic ? 0 : 1);
        assert.equal(removed.commands, fixture === automatic ? 0 : 1);
        if (fixture === manual) assert.ok(removed.observations > 0);
        console.log(
          JSON.stringify({
            event: 'history.ownership',
            owner,
            stage: 'manual-cleanup',
            at: new Date().toISOString(),
            removed,
          }),
        );
        for (const path of fixture.paths)
          await client.error(
            'GET',
            path,
            undefined,
            404,
            'lab.world_not_found',
          );
        await assertRetained(fixture);
        await client.json('POST', fixture.active.path + '/program/stop');
      }
    } finally {
      const cleaned = await Promise.allSettled(
        targets.map((target) => target.cleanup()),
      );
      for (const target of targets)
        console.log(
          JSON.stringify({
            event: 'history.owned-ledger',
            path: target.evidence + '/owned-resources.json',
          }),
        );
      const failed = cleaned.filter((result) => result.status === 'rejected');
      if (failed.length)
        cleanupFailure = new AggregateError(
          failed.map((result) => result.reason),
          'History fixture cleanup failed',
        );
    }
    if (cleanupFailure) throw cleanupFailure;
  },
);
