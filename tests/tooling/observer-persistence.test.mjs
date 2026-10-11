import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observerWriter } from '../support/observer-persistence.mjs';

for (const operation of ['mkdir', 'write', 'rename'])
  test(`observer ${operation} failure preserves the next close listener and latches safe invalidity`, () => {
    const emitter = new EventEmitter();
    const notices = [],
      published = [];
    let fail = true,
      cleaned = 0;
    const injected = (kind) => {
      if (fail && kind === operation)
        throw new Error('ENOSPC /private/evidence secret');
    };
    const writer = observerWriter(
      (status) => {
        injected('mkdir');
        injected('write');
        injected('rename');
        published.push(status);
      },
      (notice) => notices.push(notice),
    );
    emitter.on('close', () => writer.save());
    emitter.on('close', () => cleaned++);
    assert.doesNotThrow(() => emitter.emit('close'));
    assert.equal(cleaned, 1);
    assert.deepEqual(writer.status(), {
      valid: false,
      category: 'observer_write_failed',
    });
    assert.deepEqual(notices, [
      {
        event: 'motion.observer_write_failed',
        observerPersistence: {
          valid: false,
          category: 'observer_write_failed',
        },
      },
    ]);
    fail = false;
    emitter.emit('close');
    writer.finalNotice();
    assert.equal(cleaned, 2);
    assert.deepEqual(published, [
      { valid: false, category: 'observer_write_failed' },
    ]);
    assert.deepEqual(notices[1], {
      event: 'motion.observer_persistence_final',
      observerPersistence: { valid: false, category: 'observer_write_failed' },
    });
    assert(!JSON.stringify(notices).includes('secret'));
  });

test('a failing failure-notifier also cannot interrupt the subsequent close listener', () => {
  const emitter = new EventEmitter();
  let cleaned = false;
  const writer = observerWriter(
    () => {
      throw new Error('private write failure');
    },
    () => {
      throw new Error('private notifier failure');
    },
  );
  emitter.on('close', () => writer.save());
  emitter.on('close', () => {
    cleaned = true;
  });
  assert.doesNotThrow(() => emitter.emit('close'));
  assert.doesNotThrow(() => writer.finalNotice());
  assert.equal(cleaned, true);
  assert.deepEqual(writer.status(), {
    valid: false,
    category: 'observer_write_failed',
  });
});
