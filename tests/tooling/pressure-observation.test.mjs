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

test('partial diagnostic publication and malformed decode cannot close the native control owner', async () => {
  const { publishPressureRequest, dispatchPressureRequest } =
    await import('../../scripts/lib/pressure-control.mjs');
  const { readFileSync, renameSync } = await import('node:fs');
  const directory = mkdtempSync(join(tmpdir(), 'pressure-control-passivity-'));
  const native = join(directory, 'service-control.json');
  const diagnostic = join(directory, 'observer-control.json');
  writeFileSync(native, '{"revision":17,"action":"expire-machine-clock"}');
  writeFileSync(diagnostic, '{"action":"old-only"}');
  const originalNative = readFileSync(native, 'utf8');
  let ownerReachable = true,
    dispatches = 0;
  const dispatch = async () => {
    dispatches++;
    assert.equal(ownerReachable, true);
  };
  try {
    assert.equal(
      publishPressureRequest(
        diagnostic,
        { action: 'observer-health-barrier' },
        {
          writeFileSync(path) {
            writeFileSync(path, '{"action":');
            throw Object.assign(new Error('private failure'), {
              code: 'ENOSPC',
            });
          },
          renameSync,
        },
      ),
      false,
    );
    assert.equal(readFileSync(diagnostic, 'utf8'), '{"action":"old-only"}');
    writeFileSync(diagnostic, '{"action":');
    assert.equal(await dispatchPressureRequest(diagnostic, dispatch), false);
    assert.equal(dispatches, 0);
    assert.equal(ownerReachable, true);
    assert.equal(readFileSync(native, 'utf8'), originalNative);
    const request = {
      action: 'observer-health-barrier',
      request_id: '10000000-0000-0000-0000-000000000001',
      expected_owner_pid: process.pid,
    };
    assert.equal(publishPressureRequest(diagnostic, request), true);
    assert.equal(await dispatchPressureRequest(diagnostic, dispatch), true);
    assert.equal(dispatches, 1);
    assert.equal(
      await dispatchPressureRequest(diagnostic, async () => {
        throw new Error('dispatch failure');
      }),
      false,
    );
    assert.equal(ownerReachable, true);
    assert.equal(readFileSync(native, 'utf8'), originalNative);
  } finally {
    ownerReachable = false;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ACK validation rejects now+500ms and nonnumeric times without a clock allowance', async () => {
  const { assertPressureSealAck } =
    await import('../support/pressure-barrier.ts');
  const now = 1800000000000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const expected = {
      request_id: '10000000-0000-0000-0000-000000000001',
      pid: process.pid,
      afterGeneration: 3,
      requestedAt: now,
    };
    const good = {
      event: 'motion.observer_window_sealed',
      request_id: expected.request_id,
      owner: { pid: process.pid, instanceId: expected.request_id },
      publicationGeneration: 4,
      requestObservedEpochMs: now,
      sealedEpochMs: now,
      sealed: true,
      observerPersistence: { valid: true },
      snapshot: { captureId: 'current' },
    };
    assertPressureSealAck(good, expected);
    for (const bad of [
      { ...good, requestObservedEpochMs: now + 500, sealedEpochMs: now + 500 },
      { ...good, sealedEpochMs: now + 1 },
      { ...good, requestObservedEpochMs: String(now) },
      { ...good, sealedEpochMs: NaN },
      { ...good, sealedEpochMs: Infinity },
    ]) {
      assert.throws(() => assertPressureSealAck(bad, expected));
    }
  } finally {
    Date.now = originalNow;
  }
});
