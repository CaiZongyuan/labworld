import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkObserverWindow,
  sealObserverWindow,
  type ObserverWindow,
} from '../support/observer-health.ts';
import { observerWriter } from '../support/observer-persistence.mjs';

const owner = {
  pid: 101,
  clockTimeOriginMs: 1000,
  instanceId: '10000000-0000-0000-0000-000000000001',
};
const requestId = '10000000-0000-0000-0000-000000000002';
const expected = {
  requestId,
  pid: 101,
  runId: 'run-owned',
  minimumGeneration: 0,
  owner,
};
const envelope = (health: ObserverWindow) => ({
  request_id: requestId,
  boundChildPid: 101,
  runId: 'run-owned',
  receivedEpochMs: 2000,
  health,
});

test('fresh safe publication seals a detached window while global writes continue', () => {
  const state = { open: true };
  let published = 0;
  const writer = observerWriter(
    () => {
      published++;
    },
    () => {},
  );
  const ack = sealObserverWindow(
    requestId,
    owner,
    writer,
    () => ({ publicationGeneration: writer.generation(), sockets: [state] }),
    () => 1500,
  );
  assert.equal(published, 1);
  assert.deepEqual(checkObserverWindow(envelope(ack), expected), {
    confirmed: true,
    valid: true,
    category: null,
  });
  state.open = false;
  writer.save();
  writer.markInvalid();
  assert.equal(ack.publicationGeneration, 1);
  assert.deepEqual(ack.snapshot?.sockets, [{ open: true }]);
  assert.equal(ack.observerPersistence.valid, true);
});

test('current failed publication cannot be replaced by an older valid file or exit marker', () => {
  let fail = false;
  const writer = observerWriter(
    () => {
      if (fail) throw new Error('private write error');
    },
    () => {},
  );
  writer.save();
  fail = true;
  const ack = sealObserverWindow(
    requestId,
    owner,
    writer,
    () => ({ publicationGeneration: writer.generation() }),
    () => 1500,
  );
  const verdict = checkObserverWindow(
    {
      ...envelope(ack),
      staleFile: { valid: true },
      exitMarker: { valid: true },
    },
    { ...expected, minimumGeneration: 1 },
  );
  assert.deepEqual(verdict, {
    confirmed: true,
    valid: false,
    category: 'observer_write_failed',
  });
});

test('window confirmation rejects stale nonce, different served owner/run, nonfresh generation and inconsistent timestamps', () => {
  const writer = observerWriter(
    () => {},
    () => {},
  );
  const ack = sealObserverWindow(
    requestId,
    owner,
    writer,
    () => ({ publicationGeneration: writer.generation() }),
    () => 1500,
  );
  const valid = envelope(ack);
  const variants = [
    null,
    { ...valid, request_id: 'old' },
    { ...valid, boundChildPid: 102 },
    { ...valid, runId: 'foreign' },
    { ...valid, health: { ...ack, request_id: 'old' } },
    {
      ...valid,
      health: {
        ...ack,
        owner: { ...owner, instanceId: '10000000-0000-0000-0000-000000000003' },
      },
    },
    { ...valid, health: { ...ack, publicationGeneration: 0 } },
    { ...valid, health: { ...ack, sealedEpochMs: 1400 } },
    { ...valid, health: { ...ack, snapshot: { publicationGeneration: 2 } } },
  ];
  for (const value of variants)
    assert.equal(checkObserverWindow(value, expected).confirmed, false);
  assert.equal(
    checkObserverWindow(valid, { ...expected, minimumGeneration: 1 }).confirmed,
    false,
  );
});

test('snapshot and notice errors are latched without escaping a health callback', () => {
  const writer = observerWriter(
    () => {},
    () => {
      throw new Error('private notice failure');
    },
  );
  writer.finalNotice();
  assert.equal(writer.status().valid, false);
  assert.doesNotThrow(() =>
    sealObserverWindow(
      requestId,
      owner,
      writer,
      () => {
        throw new Error('private snapshot failure');
      },
      () => 1500,
    ),
  );
});
