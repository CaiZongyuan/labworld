import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceHttpFixture } from '../support/device-http.ts';
test('internal.observation: executing a preempted terminal Start leaves actual centrifuge phase idle after the next sample', async () => {
  const f = await deviceHttpFixture();
  try {
    const light = await f.register('light'),
      entity = await f.register('centrifuge');
    await f.start(light.id);
    const run = await f.start(entity.id);
    await f.action(light.id, 'light.set_power', { on: true }, 'earlier-light');
    const command = await f.action(
      entity.id,
      'centrifuge.start',
      { rpm: 500, temperature: 22, duration_seconds: 6 },
      'preempted-start',
    );
    await f.runtime.report(run.binding_id, run.id, {
      sequence: 1,
      values: { speed: 0 },
      observed_at: f.context.clock.now(),
      quality: 'bad',
    });
    await f.runtime.tick();
    assert.equal((await f.task(entity.id, command.task_id!)).status, 'failed');
    await f.runtime.tick();
    f.setTime('2026-10-10T12:00:01.000Z');
    await f.runtime.tick();
    const current = await f.entity(entity.id);
    assert.equal(current.task!.status, 'failed');
    assert.equal(current.task_result!.reason, 'device_fault');
    assert.equal(current.observation!.properties.phase.value, 'idle');
  } finally {
    await f.close();
  }
});
test('internal.observation: an old queued Stop retains Task A ownership after A completes and a new Task B is pending', async () => {
  const f = await deviceHttpFixture();
  try {
    const centrifuge = await f.register('centrifuge'),
      light = await f.register('light');
    await f.start(centrifuge.id);
    await f.start(light.id);
    const a = await f.action(
      centrifuge.id,
      'centrifuge.start',
      { rpm: 500, temperature: 22, duration_seconds: 6 },
      'task-a',
    );
    await f.runtime.tick();
    f.setTime('2026-10-10T12:00:01.000Z');
    await f.runtime.tick();
    f.setTime('2026-10-10T12:00:07.000Z');
    await f.runtime.tick();
    assert.equal(
      (await f.task(centrifuge.id, a.task_id!)).status,
      'decelerating',
    );
    await f.action(light.id, 'light.set_power', { on: true }, 'before-stop-1');
    await f.action(light.id, 'light.set_power', { on: false }, 'before-stop-2');
    const stop = await f.action(centrifuge.id, 'centrifuge.stop', {}, 'stop-a');
    assert.equal(stop.task_id, a.task_id);
    f.setTime('2026-10-10T12:00:08.000Z');
    await f.runtime.tick();
    assert.equal((await f.task(centrifuge.id, a.task_id!)).status, 'completed');
    const b = await f.action(
        centrifuge.id,
        'centrifuge.start',
        { rpm: 600, temperature: 22, duration_seconds: 6 },
        'task-b',
      ),
      before = await f.task(centrifuge.id, b.task_id!);
    await f.runtime.tick();
    await f.runtime.tick();
    assert.equal((await f.command(centrifuge.id, stop.id)).status, 'succeeded');
    assert.deepEqual(await f.task(centrifuge.id, b.task_id!), before);
    await f.runtime.tick();
    assert.equal((await f.command(centrifuge.id, b.id)).status, 'succeeded');
    assert.equal((await f.task(centrifuge.id, b.task_id!)).status, 'preparing');
  } finally {
    await f.close();
  }
});
test('internal.observation: infrastructure failure of a captured idle Stop cannot interrupt a later reserved Task', async () => {
  const f = await deviceHttpFixture(),
    transaction = f.db.transaction.bind(f.db);
  try {
    const entity = await f.register('centrifuge');
    await f.start(entity.id);
    const stop = await f.action(entity.id, 'centrifuge.stop', {}, 'idle-stop');
    assert.equal(stop.task_id, null);
    const b = await f.action(
        entity.id,
        'centrifuge.start',
        { rpm: 600, temperature: 22, duration_seconds: 6 },
        'later-start',
      ),
      before = await f.task(entity.id, b.task_id!);
    let background = 0;
    f.db.transaction = async (operation, work) =>
      transaction(operation, async (tx) => {
        if (operation.kind === 'background' && ++background === 2)
          throw new Error(
            'Owned execution infrastructure fault after committed claim',
          );
        return work(tx);
      });
    await f.runtime.tick();
    f.db.transaction = transaction;
    assert.equal((await f.command(entity.id, stop.id)).status, 'unknown');
    assert.deepEqual(await f.task(entity.id, b.task_id!), before);
    await f.runtime.tick();
    assert.equal((await f.command(entity.id, b.id)).status, 'succeeded');
  } finally {
    f.db.transaction = transaction;
    await f.close();
  }
});
test('internal.observation: a queued Start cannot resurrect a Task already decelerating for bad or uncertain source evidence', async () => {
  const f = await deviceHttpFixture();
  try {
    for (const quality of ['bad', 'uncertain']) {
      const entity = await f.register('centrifuge'),
        run = await f.start(entity.id),
        command = await f.action(
          entity.id,
          'centrifuge.start',
          { rpm: 500, temperature: 22, duration_seconds: 6 },
          quality + '-start',
        );
      assert.equal(
        await f.runtime.report(run.binding_id, run.id, {
          sequence: 1,
          values: { speed: 0 },
          observed_at: f.context.clock.now(),
          quality,
        }),
        'applied',
      );
      assert.equal(
        (await f.task(entity.id, command.task_id!)).status,
        'decelerating',
      );
      await f.runtime.tick();
      const current = await f.entity(entity.id);
      assert.equal(
        current.task!.status,
        quality === 'bad' ? 'failed' : 'unknown',
      );
      assert.equal(
        current.task_result!.status,
        quality === 'bad' ? 'failed' : 'unknown',
      );
      assert.equal(
        current.task_result!.reason,
        quality === 'bad' ? 'device_fault' : 'observation_uncertain',
      );
    }
  } finally {
    await f.close();
  }
});
