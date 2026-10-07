import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceHttpFixture } from '../support/device-http.ts';
for (const window of ['accepted', 'executing'] as const)
  test(
    'internal.observation: startup fences the ' +
      window +
      ' crash window without replay; explicit new Run and fresh Command recover',
    async () => {
      const f = await deviceHttpFixture(),
        transaction = f.db.transaction.bind(f.db);
      try {
        const entity = await f.register('light'),
          oldRun = await f.start(entity.id),
          command = await f.action(
            entity.id,
            'light.set_power',
            { on: true },
            'old-attempt',
          );
        if (window === 'executing') {
          let faulted = false;
          f.db.transaction = async (operation, work) => {
            const value = await transaction(operation, work);
            if (operation.kind === 'background' && !faulted) {
              faulted = true;
              throw new Error(
                'Owned crash-window fault after actual executing COMMIT',
              );
            }
            return value;
          };
          await f.runtime.tick();
          f.db.transaction = transaction;
        }
        assert.equal((await f.command(entity.id, command.id)).status, window);
        await f.restart();
        const recovered = await f.entity(entity.id),
          unknown = await f.command(entity.id, command.id);
        assert.equal(recovered.program_run!.status, 'interrupted');
        assert.equal(unknown.status, 'unknown');
        assert.deepEqual(unknown.result, { reason: 'runtime_interrupted' });
        assert.equal(recovered.observation, null);
        const freshRun = await f.start(entity.id);
        assert.notEqual(freshRun.id, oldRun.id);
        const fresh = await f.action(
          entity.id,
          'light.set_power',
          { on: false },
          'new-attempt',
        );
        await f.runtime.tick();
        assert.equal(
          (await f.command(entity.id, fresh.id)).status,
          'succeeded',
        );
        assert.equal(
          (await f.entity(entity.id)).observation!.properties.on.value,
          false,
        );
        assert.deepEqual(
          await f.action(
            entity.id,
            'light.set_power',
            { on: true },
            'old-attempt',
          ),
          unknown,
        );
        assert.equal(
          await f.runtime.report(oldRun.binding_id, oldRun.id, {
            sequence: 1,
            values: { on: true },
            observed_at: f.context.clock.now(),
            quality: 'good',
          }),
          'stale_run',
        );
        assert.equal(
          (await f.entity(entity.id)).observation!.properties.on.value,
          false,
        );
      } finally {
        f.db.transaction = transaction;
        await f.close();
      }
    },
  );
