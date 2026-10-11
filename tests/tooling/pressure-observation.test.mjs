import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pressureObservation } from '../support/pressure-observation.mjs';
import { TlsPressureObserver } from '../support/tls-pressure-observer.mjs';

test('failed full observer construction and metric hook cannot preempt original delegation', () => {
  const path = mkdtempSync(join(tmpdir(), 'pressure-passivity-'));
  const blocker = join(path, 'blocked');
  writeFileSync(blocker, 'regular file');
  const notices = [];
  const health = pressureObservation('server', (row) => notices.push(row));
  try {
    const observer = health.observe(
      () => new TlsPressureObserver(blocker, new Map(), health),
    );
    assert.equal(observer, undefined);
    let delegated = 0;
    function original(...args) {
      delegated++;
      return args;
    }
    function wrapper(...args) {
      health.observe(() => {
        throw new Error('private text');
      });
      return original(...args);
    }
    assert.deepEqual(wrapper('same data', 'same options'), [
      'same data',
      'same options',
    ]);
    assert.equal(delegated, 1);
    let cleaned = 0;
    health.cleanup(() => cleaned++);
    assert.equal(cleaned, 1);
    assert.equal(health.status().valid, false);
    health.finalNotice();
    assert.equal(notices.length, 2);
    assert(!JSON.stringify(notices).includes('private text'));
    assert.equal(notices.at(-1).diagnosticHealth.valid, false);
    const sentinel = new Error('original failure');
    assert.throws(
      () => {
        health.observe(() => {});
        throw sentinel;
      },
      (error) => error === sentinel,
    );
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('fresh sealed capture cannot resurrect earlier failed observation or accept stale ACK', async () => {
  const { assertPressureSealAck } =
    await import('../support/pressure-barrier.ts');
  const health = pressureObservation('server', () => {});
  health.published();
  health.observe(() => {
    throw new Error('write failed after old valid publication');
  });
  const request = { request_id: '10000000-0000-0000-0000-000000000001' };
  const requestedAt = Date.now();
  const ack = health.seal(request, () => ({ captureId: 'fresh' }));
  assert.equal(ack.observerPersistence.valid, false);
  const expected = {
    ...request,
    pid: process.pid,
    afterGeneration: 1,
    requestedAt,
  };
  assert.throws(() => assertPressureSealAck(ack, expected));
  let postSealWrites = 0;
  health.observe(() => postSealWrites++);
  assert.equal(postSealWrites, 0);
  const good = pressureObservation('server', () => {}).seal(request, () => ({
    captureId: 'new',
  }));
  assertPressureSealAck(good, { ...expected, afterGeneration: 0 });
  for (const bad of [
    undefined,
    { ...good, request_id: 'old' },
    { ...good, owner: { ...good.owner, pid: process.pid + 1 } },
    { ...good, publicationGeneration: 0 },
    { ...good, requestObservedEpochMs: requestedAt - 1 },
    { ...good, snapshot: null },
  ]) {
    assert.throws(() =>
      assertPressureSealAck(bad, { ...expected, afterGeneration: 0 }),
    );
  }
});
