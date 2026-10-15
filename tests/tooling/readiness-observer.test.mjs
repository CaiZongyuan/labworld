import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
const source = readFileSync(
  new URL(
    '../../packages/views/src/lab/readiness-observer.ts',
    import.meta.url,
  ),
  'utf8',
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { ReadinessObserver, ReadinessLedger, safeReadinessFact } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);
function sample() {
  const facts = [];
  new ReadinessObserver(
    (fact) => facts.push(fact),
    () => 100,
  ).emit('inputs', {
    labsPending: false,
    worldPending: false,
    renderBusy: true,
  });
  return facts[0];
}
test('closed projection drops private extras and rejects coercible enums and unsafe counts', () => {
  const fact = sample();
  assert(
    !JSON.stringify(
      safeReadinessFact({ ...fact, secret: 'must-not-export' }),
    ).includes('must-not-export'),
  );
  for (const [field, value] of [
    ['phase', { toString: () => 'inputs', secret: 'must-not-export' }],
    ['fault', { toString: () => 'clock', secret: 'must-not-export' }],
    ['owner', 'private'],
    ['atMs', NaN],
    ['bytes', -1],
    ['pending', 'private'],
  ])
    assert.equal(safeReadinessFact({ ...fact, [field]: value }), null);
});
test('channel sync throw and rejection cannot escape the producer or restart a failed owner', async () => {
  for (const channel of [
    () => {
      throw new Error('private');
    },
    () => Promise.reject(new Error('private')),
  ]) {
    const observer = new ReadinessObserver(channel, () => 10);
    assert.doesNotThrow(() => observer.emit('body-start'));
    observer.close();
    observer.open();
    observer.emit('body-ready');
    await Promise.resolve();
  }
});
test('owner close blocks late producers and explicit reopen preserves sequence without a timer', () => {
  const facts = [];
  let now = 10;
  const observer = new ReadinessObserver(
    (fact) => facts.push(fact),
    () => now++,
  );
  observer.emit('body-start');
  observer.close();
  observer.emit('body-ready');
  assert.deepEqual(
    facts.map((fact) => fact.phase),
    ['body-start', 'owner-close'],
  );
  observer.open();
  observer.emit('viewport', { pending: false });
  assert.deepEqual(
    facts.map((fact) => fact.sequence),
    [1, 2, 3, 4],
  );
});
test('clock regression and overflow stay explicit unknown and cannot be reopened', () => {
  for (const scenario of ['clock', 'overflow']) {
    const facts = [];
    let now = 10;
    const observer = new ReadinessObserver(
      (fact) => facts.push(fact),
      () => now,
    );
    observer.emit('inputs');
    if (scenario === 'clock') {
      now = 5;
      observer.emit('inputs');
    } else for (let index = 0; index < 80; index++) observer.emit('inputs');
    const last = facts.at(-1);
    assert.equal(last.phase, 'unknown');
    assert.equal(last.fault, scenario);
    const length = facts.length;
    observer.open();
    observer.emit('viewport');
    assert.equal(facts.length, length);
    assert(length <= 64);
  }
});
test('passive ledger freezes the first boundary, keeps missing pipeline and cause unevaluated, and drops late data', () => {
  const ledger = new ReadinessLedger();
  ledger.accept(sample(), 200);
  const snapshot = ledger.stop();
  ledger.accept({ ...sample(), phase: 'body-ready' }, 201);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.readinessVerdict, 'not-evaluated');
  assert.equal(snapshot.cause, 'unknown');
  assert.equal(new ReadinessLedger().stop().status, 'unknown');
});
test('malformed, faulted, lost-sequence and closed-owner data stay unknown', () => {
  for (const change of [
    null,
    { sequence: 3 },
    { atMs: 5 },
    { fault: 'overflow', phase: 'unknown' },
    { phase: 'owner-close' },
  ]) {
    const ledger = new ReadinessLedger();
    const fact = sample();
    ledger.accept(fact, 200);
    ledger.accept(change ? { ...fact, sequence: 2, ...change } : null, 201);
    if (change?.phase === 'owner-close')
      ledger.accept({ ...fact, sequence: 3, phase: 'body-ready' }, 202);
    assert.equal(ledger.stop().status, 'unknown');
  }
});
test('navigation separates browser clock resets while receiver clock regressions and cap stay unknown', () => {
  const ledger = new ReadinessLedger();
  ledger.accept(sample(), 200);
  ledger.navigate();
  ledger.accept({ ...sample(), atMs: 1 }, 201);
  assert.equal(ledger.stop().status, 'observed');
  const clock = new ReadinessLedger();
  clock.accept(sample(), 200);
  clock.accept({ ...sample(), sequence: 2 }, 199);
  assert.equal(clock.stop().status, 'unknown');
  const cap = new ReadinessLedger();
  for (let index = 0; index < 70; index++)
    cap.accept({ ...sample(), owner: 1, sequence: index + 1 }, index);
  assert.equal(cap.stop().rows.length, 64);
  assert.equal(cap.stop().status, 'unknown');
});

test('passive receiver unregisters both listeners and retains only closed facts before stop', async () => {
  const receiverSource = readFileSync(
    new URL('../e2e/readiness-observation.ts', import.meta.url),
    'utf8',
  );
  const receiverCode = ts
    .transpileModule(receiverSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(
      "'../../packages/views/src/lab/readiness-observer'",
      "'data:text/javascript;base64," +
        Buffer.from(code).toString('base64') +
        "'",
    );
  const { observeReadiness } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(receiverCode).toString('base64')
  );
  const page = new EventEmitter();
  const frame = {};
  page.mainFrame = () => frame;
  const receiver = observeReadiness(page);
  page.emit('framenavigated', frame);
  page.emit('console', { text: () => 'unrelated private message' });
  page.emit('console', {
    text: () =>
      'LAB_READINESS_FACT:' +
      JSON.stringify({ ...sample(), secret: 'must-not-export' }),
  });
  const snapshot = receiver.stop();
  assert.equal(page.listenerCount('console'), 0);
  assert.equal(page.listenerCount('framenavigated'), 0);
  page.emit('console', {
    text: () => 'LAB_READINESS_FACT:' + JSON.stringify(sample()),
  });
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].generation, 1);
  assert(!JSON.stringify(snapshot).includes('must-not-export'));
});

test('actual original busy catch keeps the same rejection and first cutoff when evidence writes fail', async () => {
  const text = readFileSync(
    new URL('../e2e/lab-render-metric-readiness.spec.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile(
    'readiness.spec.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  let wrapper;
  function visit(node) {
    if (
      ts.isTryStatement(node) &&
      node.tryBlock.getText().includes("'aria-busy'") &&
      !node.finallyBlock
    )
      wrapper = node;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert(wrapper);
  for (const writeFails of [false, true]) {
    const cause = new Error('original assertion');
    const order = [];
    const context = vm.createContext({
      expect: () => ({
        toHaveAttribute: async (...args) => {
          assert.deepEqual(args, ['aria-busy', 'false']);
          throw cause;
        },
      }),
      page: { locator: () => ({}) },
      readinessObserver: {
        stop: () => {
          order.push('readiness-stop');
          return { rows: [] };
        },
      },
      frontier: {
        stop: () => {
          order.push('traffic-stop');
          return {};
        },
      },
      writeFileSync: () => {
        order.push('write');
        if (writeFails) throw new Error('writer');
      },
      join: () => 'owned-file',
      process: { env: {} },
      captureFrontierFailure: async () => {
        order.push('later-confirmation');
      },
      gateProjection: () => ({}),
      initial: { version: '8' },
      entity: { id: 'private' },
    });
    const functionCode = ts.transpileModule(
      'async function run(){' + wrapper.getText() + '}',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    vm.runInContext(functionCode, context);
    await assert.rejects(
      vm.runInContext('run()', context),
      (error) => error === cause,
    );
    assert.deepEqual(order, [
      'readiness-stop',
      'traffic-stop',
      'write',
      'later-confirmation',
    ]);
  }
});
