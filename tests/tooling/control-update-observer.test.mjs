import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function load(path) {
  const output = ts.transpileModule(
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
  );
}
const { ControlUpdateObserver } = await load(
  '../../packages/views/src/lab/control-update-observer.ts',
);
const { associateControlUpdates, safeControlSnapshot } = await load(
  '../e2e/control-update-attribution.ts',
);

test('owned wrapper preserves exactly one call, this, args, return, factor and throw', () => {
  let now = 100,
    calls = 0;
  const canvas = {};
  const token = { secret: 'must-not-export' };
  const cause = new Error('must-not-export');
  const owner = {
    factor: 0.05,
    update(...args) {
      calls++;
      assert.equal(this, owner);
      assert.equal(owner.factor, 0.05);
      if (args[0] === cause) throw cause;
      assert.equal(args[0], token);
      return token;
    },
  };
  const original = owner.update;
  const observer = new ControlUpdateObserver(() => now++);
  observer.bind(owner, canvas);
  assert.equal(owner.update(token), token);
  assert.throws(
    () => owner.update(cause),
    (error) => error === cause,
  );
  assert.equal(calls, 2);
  assert(!JSON.stringify(observer.snapshot()).includes('must-not-export'));
  observer.detach();
  assert.equal(owner.update, original);
  assert.equal(canvas.getControlUpdateObservation, undefined);
});

test('actual provider, framing and nonframe calls remain separate', () => {
  let now = 100;
  const owner = {
    update() {
      return false;
    },
  };
  const observer = new ControlUpdateObserver(() => now++);
  observer.bind(owner, {});
  observer.frame(true);
  owner.update();
  observer.frame(false);
  observer.gesture(true, owner);
  owner.update();
  observer.gesture(false, owner);
  observer.framingUpdate(() => owner.update());
  const bin = observer.snapshot().bins[0];
  assert.equal(bin.updates, 3);
  assert.equal(bin.frameCallbacks, 1);
  assert.equal(bin.providerUpdates, 1);
  assert.equal(bin.otherUpdates, 1);
  assert.equal(bin.framingUpdates, 1);
  assert.equal(bin.returnedFalse, 3);
  observer.detach();
});

test('stale wrapper, changed method and unknown reader lose coverage without replacing another owner', () => {
  let now = 10;
  const a = {
      update() {
        return true;
      },
    },
    b = {
      update() {
        return true;
      },
    };
  const observer = new ControlUpdateObserver(() => now++),
    canvas = {};
  observer.bind(a, canvas);
  const stale = a.update;
  observer.bind(b, canvas);
  stale.call(a);
  assert.equal(observer.snapshot().status, 'unknown');
  const replacement = () => false;
  b.update = replacement;
  observer.detach();
  assert.equal(b.update, replacement);
  const foreign = () => ({ secret: 'must-not-export' });
  canvas.getControlUpdateObservation = foreign;
  const original = a.update;
  observer.bind(a, canvas);
  assert.equal(a.update, original);
  assert.equal(canvas.getControlUpdateObservation, foreign);
});

test('clock regression and bounded overflow stay unknown while native calls still execute', () => {
  let now = 10,
    calls = 0;
  const owner = {
    update() {
      calls++;
      return true;
    },
  };
  const observer = new ControlUpdateObserver(() => now),
    canvas = {};
  observer.bind(owner, canvas);
  now = 5;
  owner.update();
  assert.equal(observer.snapshot().status, 'unknown');
  assert.equal(calls, 1);
  observer.detach();
  now = 20;
  observer.bind(owner, canvas);
  for (let i = 0; i < 257; i++) {
    now += 1000;
    owner.update();
  }
  assert.equal(observer.snapshot().status, 'unknown');
  assert.equal(observer.snapshot().bins.length, 256);
  assert.equal(calls, 258);
  observer.detach();
});

test('safe projection discards extra fields and invalid data', () => {
  let now = 100;
  const observer = new ControlUpdateObserver(() => now++);
  observer.bind({ update() {} }, {});
  observer.frame(true);
  const sample = observer.snapshot();
  const projected = safeControlSnapshot({
    ...sample,
    secret: 'must-not-export',
  });
  assert(!JSON.stringify(projected).includes('must-not-export'));
  assert.equal(
    safeControlSnapshot({ ...sample, bins: [{ secret: 'bad' }] }),
    null,
  );
  observer.detach();
});

test('pair association uses bounded calibration and refuses uncovered, changed-owner and inconsistent windows', () => {
  const bin = {
    first: 90,
    last: 220,
    updates: 1,
    providerUpdates: 1,
    otherUpdates: 0,
    framingUpdates: 0,
    frameCallbacks: 1,
    gestureStarts: 0,
    gestureEnds: 0,
    returnedTrue: 1,
    returnedFalse: 0,
    returnedOther: 0,
    threw: 0,
  };
  const observation = {
    schema: 'control-update-observer-v1',
    status: 'covered',
    coveredFrom: 50,
    observedAt: 230,
    reason: null,
    ownership: [{ at: 50, kind: 'attach' }],
    bins: [bin],
  };
  const sample = {
    nodeStart: 100,
    nodeEnd: 120,
    browserStart: 200,
    browserEnd: 210,
    observation,
  };
  const a = { nodeStart: 0, nodeEnd: 30 },
    b = { nodeStart: 70, nodeEnd: 90 };
  const result = associateControlUpdates(a, b, sample);
  assert.equal(result.status, 'covered-under-clock-model');
  assert.equal(result.calibration.uncertaintyMs, 10);
  assert.equal(
    associateControlUpdates(a, b, {
      ...sample,
      observation: { ...observation, coveredFrom: 95 },
    }).status,
    'unknown',
  );
  assert.equal(
    associateControlUpdates(a, b, {
      ...sample,
      observation: { ...observation, ownership: [{ at: 120, kind: 'lost' }] },
    }).status,
    'unknown',
  );
  assert.equal(
    associateControlUpdates(a, b, { ...sample, browserEnd: 230 }).status,
    'unknown',
  );
  assert.equal(associateControlUpdates(a, b, undefined).status, 'unknown');
});

function coveredComparison() {
  return {
    before: { nodeStart: 0, nodeEnd: 30 },
    after: { nodeStart: 70, nodeEnd: 90 },
    comparison: {
      nodeStart: 100,
      nodeEnd: 120,
      browserStart: 200,
      browserEnd: 210,
      observation: {
        schema: 'control-update-observer-v1',
        status: 'covered',
        coveredFrom: 50,
        observedAt: 400,
        reason: null,
        ownership: [{ at: 50, kind: 'attach' }],
        bins: [],
      },
    },
  };
}

for (const field of ['status', 'reason', 'kind'])
  test(`closed ${field} rejects coercible objects rather than exporting private fields`, () => {
    const { comparison } = coveredComparison();
    const sample = comparison.observation;
    let coercions = 0;
    const privateEnum = {
      private: 'must-not-export',
      toString: () => {
        coercions++;
        return field === 'status'
          ? 'covered'
          : field === 'kind'
            ? 'attach'
            : 'clock';
      },
    };
    if (field === 'kind') sample.ownership[0].kind = privateEnum;
    else sample[field] = privateEnum;
    assert.equal(safeControlSnapshot(sample), null);
    assert.equal(coercions, 0);
  });

for (const reason of ['not-attached', 'clock', 'overflow', 'ownership'])
  test(`covered with known ${reason} fault cannot establish coverage`, () => {
    const { before, after, comparison } = coveredComparison();
    comparison.observation.reason = reason;
    assert.equal(
      associateControlUpdates(before, after, comparison).status,
      'unknown',
    );
  });

for (const [name, ownership, coveredFrom] of [
  ['missing attach', [], 50],
  [
    'detach before window',
    [
      { at: 50, kind: 'attach' },
      { at: 60, kind: 'detach' },
    ],
    50,
  ],
  [
    'lost before window',
    [
      { at: 50, kind: 'attach' },
      { at: 60, kind: 'lost' },
    ],
    50,
  ],
  [
    'mismatched reattach',
    [
      { at: 50, kind: 'attach' },
      { at: 60, kind: 'detach' },
      { at: 80, kind: 'attach' },
    ],
    50,
  ],
  [
    'detached interval spans window',
    [
      { at: 50, kind: 'attach' },
      { at: 80, kind: 'detach' },
      { at: 220, kind: 'attach' },
    ],
    50,
  ],
  [
    'reversed history',
    [
      { at: 50, kind: 'attach' },
      { at: 40, kind: 'detach' },
      { at: 80, kind: 'attach' },
    ],
    80,
  ],
  [
    'future history',
    [
      { at: 50, kind: 'attach' },
      { at: 450, kind: 'detach' },
    ],
    50,
  ],
])
  test(`incoherent ownership ${name} cannot establish coverage`, () => {
    const { before, after, comparison } = coveredComparison();
    comparison.observation.ownership = ownership;
    comparison.observation.coveredFrom = coveredFrom;
    assert.equal(
      associateControlUpdates(before, after, comparison).status,
      'unknown',
    );
  });

test('coherent reattachment before the window remains covered', () => {
  const { before, after, comparison } = coveredComparison();
  comparison.observation.coveredFrom = 80;
  comparison.observation.ownership = [
    { at: 50, kind: 'attach' },
    { at: 60, kind: 'lost' },
    { at: 65, kind: 'lost' },
    { at: 70, kind: 'detach' },
    { at: 80, kind: 'attach' },
  ];
  assert.equal(
    associateControlUpdates(before, after, comparison).status,
    'covered-under-clock-model',
  );
});

test('projection discards private extras on primitive ownership and bins and rejects unrecognized enums', () => {
  let now = 50;
  const observer = new ControlUpdateObserver(() => now++);
  observer.bind({ update() {} }, {});
  observer.frame(true);
  const sample = observer.snapshot();
  const projected = safeControlSnapshot({
    ...sample,
    ownership: sample.ownership.map((event) => ({
      ...event,
      private: 'must-not-export',
    })),
    bins: sample.bins.map((bin) => ({ ...bin, private: 'must-not-export' })),
  });
  assert.equal(projected.status, 'covered');
  assert(!JSON.stringify(projected).includes('must-not-export'));
  for (const field of ['status', 'reason'])
    assert.equal(
      safeControlSnapshot({ ...sample, [field]: 'unrecognized' }),
      null,
    );
  observer.detach();
});

for (const [name, before, after, calibration] of [
  [
    'reversed captures and containing interval',
    { nodeStart: 140, nodeEnd: 150 },
    { nodeStart: 0, nodeEnd: 10 },
    {},
  ],
  [
    'overlapping captures',
    { nodeStart: 0, nodeEnd: 80 },
    { nodeStart: 70, nodeEnd: 90 },
    {},
  ],
  [
    'comparison before second capture',
    { nodeStart: 0, nodeEnd: 30 },
    { nodeStart: 70, nodeEnd: 90 },
    { nodeStart: 50, nodeEnd: 65, browserStart: 150, browserEnd: 160 },
  ],
])
  test(`invalid chronology ${name} cannot report zero-bin coverage`, () => {
    const { comparison } = coveredComparison();
    assert.equal(
      associateControlUpdates(before, after, { ...comparison, ...calibration })
        .status,
      'unknown',
    );
  });
