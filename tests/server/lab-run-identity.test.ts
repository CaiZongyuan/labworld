import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import type {
  DeviceProgramRun,
  LabWorld,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { deviceHttpFixture } from '../support/device-http.ts';

test('internal.observation: tied storage clocks select the newly started Run independently of random UUID ordering', async (t) => {
  const f = await deviceHttpFixture();
  try {
    const entity = await f.register('light');
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    // Control the external Node RNG boundary with descending UUIDs, without
    // depending on the number or order of internal UUID allocations.
    let next = 0xffff_ffff;
    t.mock.method(
      crypto,
      'randomUUID',
      () =>
        `${(next--).toString(16).padStart(8, '0')}-ffff-4fff-bfff-ffffffffffff`,
    );
    syncBuiltinESMExports();
    const old = await f.start(entity.id);
    await f.client.json('POST', f.path(entity.id) + '/program/stop');
    const fresh = await f.start(entity.id);
    assert.equal(
      fresh.started_at,
      old.started_at,
      'owned host clock produces the actual storage timestamp tie',
    );
    assert.notEqual(fresh.id, old.id, '201 must identify the new Run');
    assert.equal(fresh.status, 'running');
    assert.equal((await f.entity(entity.id)).program_run!.id, fresh.id);
    const world = await f.client.json<LabWorld>(
      'GET',
      '/api/v1/lab/labs/' + f.lab.id + '/world',
    );
    assert.equal(
      world.entities.find((entry) => entry.id === entity.id)!.program_run!.id,
      fresh.id,
    );
    const repeat = await f.client.json<DeviceProgramRun>(
      'POST',
      f.path(entity.id) + '/program/start',
    );
    assert.equal(
      repeat.id,
      fresh.id,
      'repeated Start returns 200 with the current Run',
    );
    assert.equal(repeat.status, 'running');
    const retained = await f.client.json<DeviceProgramRun>(
      'GET',
      f.path(entity.id) + '/runs/' + old.id,
    );
    assert.equal(retained.id, old.id);
    assert.equal(retained.status, 'stopped');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    t.mock.timers.reset();
    await f.close();
  }
});

test('internal.observation: commands accepted on a tied storage clock execute in acceptance order', async (t) => {
  const f = await deviceHttpFixture();
  try {
    const entity = await f.register('light');
    await f.start(entity.id);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let next = 0xffff_ffff;
    t.mock.method(
      crypto,
      'randomUUID',
      () =>
        `${(next--).toString(16).padStart(8, '0')}-ffff-4fff-bfff-ffffffffffff`,
    );
    syncBuiltinESMExports();
    const first = await f.action(
        entity.id,
        'light.set_power',
        { on: true },
        'first-on',
      ),
      second = await f.action(
        entity.id,
        'light.set_power',
        { on: false },
        'second-off',
      );
    assert.equal(
      first.created_at,
      second.created_at,
      'actual Command storage clocks tie',
    );
    await f.runtime.tick();
    assert.equal(
      (await f.command(entity.id, first.id)).status,
      'succeeded',
      'the first accepted Command executes first',
    );
    assert.equal((await f.command(entity.id, second.id)).status, 'accepted');
    await f.runtime.tick();
    assert.equal((await f.command(entity.id, second.id)).status, 'succeeded');
    assert.equal(
      (await f.entity(entity.id)).observation!.properties.on.value,
      false,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    t.mock.timers.reset();
    await f.close();
  }
});

test('internal.observation: tied storage clocks keep the new pending Task and result current after an old Task ends', async (t) => {
  const f = await deviceHttpFixture();
  try {
    const entity = await f.register('centrifuge'),
      run = await f.start(entity.id);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    let next = 0xffff_ffff;
    t.mock.method(
      crypto,
      'randomUUID',
      () =>
        `${(next--).toString(16).padStart(8, '0')}-ffff-4fff-bfff-ffffffffffff`,
    );
    syncBuiltinESMExports();
    const parameters = { rpm: 500, temperature: 22, duration_seconds: 6 },
      a = await f.action(entity.id, 'centrifuge.start', parameters, 'task-a');
    await f.runtime.report(run.binding_id, run.id, {
      sequence: 1,
      values: { speed: 0 },
      observed_at: f.context.clock.now(),
      quality: 'bad',
    });
    await f.runtime.tick();
    const old = await f.task(entity.id, a.task_id!);
    assert.equal(old.status, 'failed');
    const b = await f.action(
        entity.id,
        'centrifuge.start',
        parameters,
        'task-b',
      ),
      fresh = await f.task(entity.id, b.task_id!);
    assert.equal(
      fresh.created_at,
      old.created_at,
      'actual Task storage clocks tie',
    );
    const current = await f.entity(entity.id);
    assert.equal(
      current.task!.id,
      b.task_id,
      'current Task must be the newly accepted pending Task',
    );
    assert.equal(current.task!.status, 'pending');
    assert.equal(current.task_result!.id, fresh.result_id);
    assert.equal(current.task_result!.status, 'pending');
    await f.client.error(
      'POST',
      f.path(entity.id) + '/actions',
      {
        capability: 'centrifuge.start',
        parameters,
      },
      409,
      'lab.device_busy',
      { 'idempotency-key': 'must-be-busy' },
    );
    assert.deepEqual(await f.task(entity.id, a.task_id!), old);
    assert.deepEqual(await f.task(entity.id, b.task_id!), fresh);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    t.mock.timers.reset();
    await f.close();
  }
});
