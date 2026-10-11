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
