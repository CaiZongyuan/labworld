import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  lab334State,
  assertLab334Seal,
  lab334BootstrapSource,
} from '../support/lab334-observation.ts';
import { observeLabRender } from '../../packages/views/src/lab/render-probe.ts';
const owner = () => ({
  caseNonce: randomUUID(),
  pageId: randomUUID(),
  instanceId: randomUUID(),
  role: 'first',
});

test('actual opt-in seam cannot preempt original callbacks, values, errors or teardown', () => {
  const state = lab334State(owner());
  const sink = Symbol.for('lab-word.lab334-observer'),
    health = Symbol.for('lab-word.lab334-state');
  globalThis[health] = state;
  globalThis[sink] = () => {
    throw new Error('private text');
  };
  const value = {},
    sentinel = new Error('original exception');
  let calls = 0,
    disposed = 0;
  function original(receiver, argument) {
    calls++;
    assert.equal(receiver, value);
    return argument;
  }
  try {
    observeLabRender({ producer: 'loader', stage: 'parse' });
    assert.equal(original(value, value), value);
    assert.equal(calls, 1);
    assert.equal(state.status().valid, false);
    assert.throws(
      () => {
        observeLabRender({ producer: 'loader', stage: 'caught' });
        throw sentinel;
      },
      (error) => error === sentinel,
    );
  } finally {
    disposed++;
    delete globalThis[sink];
    delete globalThis[health];
  }
  assert.equal(disposed, 1);
});

test('mkdir/write/rename and notifier faults latch invalidity and keep original fallthrough', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab334-pure-'));
  const blocked = join(directory, 'blocked');
  writeFileSync(blocked, 'file');
  try {
    for (const operation of [
      () => mkdirSync(blocked),
      () => writeFileSync(join(blocked, 'tuple'), 'data'),
      () => renameSync(join(directory, 'missing'), join(directory, 'target')),
    ]) {
      const state = lab334State(owner(), () => {
        throw new Error('notice');
      });
      let original = 0,
        teardown = 0;
      try {
        state.run(operation);
        original++;
        state.run(() => {});
        assert.equal(state.status().valid, false);
      } finally {
        teardown++;
      }
      assert.equal(original, 1);
      assert.equal(teardown, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded overflow and immutable current seal reject stale/future/false/wrong owner', () => {
  let clock = 100;
  const identity = owner();
  const state = lab334State(
    identity,
    () => {},
    () => clock,
  );
  state.record({ producer: 'loader', stage: 'parse', asset: 'one' });
  const requestId = randomUUID();
  const seal = state.seal(requestId);
  const expected = {
    ...identity,
    requestId,
    requestedAt: 100,
    receivedAt: 100,
  };
  assertLab334Seal(seal, expected);
  state.record({ producer: 'loader', stage: 'caught' });
  assert.equal(seal.rows.length, 1);
  for (const invalid of [
    { ...seal, requestId: 'old' },
    { ...seal, pageId: randomUUID() },
    { ...seal, requestObservedAt: 99 },
    { ...seal, sealedAt: 101 },
    { ...seal, health: { valid: false } },
    { ...seal, sealedAt: Infinity },
  ])
    assert.throws(() => assertLab334Seal(invalid, expected));
  const overflow = lab334State(owner());
  for (let i = 0; i < 257; i++)
    overflow.record({ producer: 'loader', stage: 'parse' });
  assert.equal(overflow.status().valid, false);
  const identities = lab334State(owner());
  for (let i = 0; i < 33; i++)
    identities.record({ producer: 'loader', stage: 'parse', asset: String(i) });
  assert.equal(identities.status().valid, false);
});

test('the identical serialized browser recorder seals within its current realm', () => {
  const factory = runInNewContext('(' + lab334State.toString() + ')', {
    performance,
    Date,
    WeakMap,
  });
  const identity = owner(),
    state = factory(identity);
  state.record({
    producer: 'loader',
    stage: 'parse',
    asset: 'private-model-id',
  });
  const requestId = randomUUID(),
    requestedAt = Date.now(),
    seal = state.seal(requestId);
  assertLab334Seal(seal, {
    ...identity,
    requestId,
    requestedAt,
    receivedAt: Date.now(),
  });
  assert.equal(seal.rows.length, 1);
});

test('exact injected bootstrap contains UUID, factory and registration faults without a page error', () => {
  const identity = owner(),
    sentinel = new Error('construction sentinel');
  const source = lab334BootstrapSource(identity);
  const sink = Symbol.for('lab-word.lab334-observer'),
    stateKey = Symbol.for('lab-word.lab334-state');
  for (const fault of ['uuid', 'factory', 'registration']) {
    const sandbox = { performance, Date, WeakMap, crypto: { randomUUID } };
    if (fault === 'uuid')
      sandbox.crypto.randomUUID = () => {
        throw sentinel;
      };
    if (fault === 'factory')
      sandbox.WeakMap = class {
        constructor() {
          throw sentinel;
        }
      };
    if (fault === 'registration')
      Object.defineProperty(sandbox, sink, {
        configurable: true,
        set() {
          throw sentinel;
        },
      });
    assert.doesNotThrow(() =>
      runInNewContext(source + ';globalThis.originalContinued=true', sandbox),
    );
    assert.equal(sandbox.originalContinued, true);
    assert.equal(sandbox[stateKey], undefined);
    assert.equal(sandbox[sink], undefined);
  }
});

test('bounded recorder retains the actual aggregate viewport decision with current renderer identity', () => {
  const state = lab334State(owner()),
    renderer = {};
  state.record({ producer: 'viewport', stage: 'viewport-ready', renderer });
  state.record({ producer: 'viewport', stage: 'viewport-failed', renderer });
  const seal = state.seal(randomUUID());
  assert.deepEqual(
    seal.rows.map((row) => row.stage),
    ['viewport-ready', 'viewport-failed'],
  );
  assert.deepEqual(
    seal.rows.map((row) => row.renderer),
    [1, 1],
  );
});
