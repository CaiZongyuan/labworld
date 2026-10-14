import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const helperUrl = new URL('../support/test-failure-facts.ts', import.meta.url)
  .href;
const originalFlag = process.env.TEST_FAILURE_FACTS;
process.env.TEST_FAILURE_FACTS = '1';
const files = new Map();
let writeFails = false;
globalThis.__testFailureWriter = async (path, data) => {
  if (writeFails) throw new Error('evidence-write-failed');
  files.set(path, JSON.parse(data));
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node:fs/promises' && context.parentURL === helperUrl)
      return {
        url: 'data:text/javascript,export const writeFile=(...args)=>globalThis.__testFailureWriter(...args)',
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const facts = await import(helperUrl);
hook.deregister();
if (originalFlag === undefined) delete process.env.TEST_FAILURE_FACTS;
else process.env.TEST_FAILURE_FACTS = originalFlag;
const sentinel = 'credential-sentinel https://private.invalid/token';
const api = {
  url: sentinel,
  headers: { authorization: sentinel },
  cookie: sentinel,
  csrf: sentinel,
};
const transpile = (text) =>
  ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
function source(path) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}
function find(root, predicate) {
  const rows = [];
  function walk(node) {
    if (predicate(node)) rows.push(node);
    ts.forEachChild(node, walk);
  }
  walk(root);
  return rows;
}
function safe(value) {
  const raw = JSON.stringify(value);
  for (const item of [
    sentinel,
    'private-id',
    'prepared',
    'SIGTERM',
    'generation',
  ])
    assert.equal(raw.includes(item), false);
}

test('failure facts preserve first terminal and owned first failure without raw data', async () => {
  facts.beginFailureFixture();
  const state = facts.createStateFacts('running', 20);
  facts.recordStateRead(
    state,
    { status: 'starting', revision: 1, reason: null, ended_at: null },
    1,
  );
  facts.recordStateRead(
    state,
    {
      status: 'interrupted',
      revision: 2,
      reason: 'machine_auth_timeout',
      ended_at: sentinel,
      credential: sentinel,
    },
    2,
  );
  facts.recordStateRead(
    state,
    {
      status: 'interrupted',
      revision: 3,
      reason: 'publisher_disconnected',
      ended_at: sentinel,
    },
    3,
  );
  await facts.captureStateFailure(state, '/first', new Error(sentinel));
  const value = files.get('/first/test-failure-facts.json');
  assert.equal(value.firstTerminal.reason, 'machine_auth_timeout');
  assert.equal(value.firstTerminal.revision, 2);
  assert.equal(value.last.revision, 3);
  safe(value);
  facts.beginFailureFixture();
  const later = facts.createStateFacts('running', 20);
  facts.recordStateRead(later, { status: 'starting' }, 1);
  await facts.captureStateFailure(later, '/first', new Error(sentinel));
  assert.deepEqual(files.get('/first/test-failure-facts.json'), value);
  await facts.captureStateFailure(state, '/stale', new Error(sentinel));
  assert.equal(files.has('/stale/test-failure-facts.json'), false);
});

test('state failure receipts use the unchanged explicit consumer poll policy', async () => {
  for (const [consumer, pollDelayMs] of [
    ['reliability', 20],
    ['authority', 25],
  ]) {
    const path =
      consumer === 'authority'
        ? '../server/session-authority.test.ts'
        : '../e2e/recording-reliability.test.ts';
    const call = find(
      source(path),
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText() === 'createStateFacts',
    )[0];
    assert.equal(call.arguments[1].getText(), String(pollDelayMs));
    facts.beginFailureFixture();
    const observed = facts.createStateFacts('running', pollDelayMs);
    facts.recordStateRead(observed, { status: 'starting', ended_at: null }, 1);
    await facts.captureStateFailure(
      observed,
      '/poll-policy-' + consumer,
      new Error(sentinel),
    );
    const receipt = files.get(
      '/poll-policy-' + consumer + '/test-failure-facts.json',
    );
    assert.equal(receipt.pollDelayMs, pollDelayMs);
    assert.equal(receipt.originalWaitMs, 10000);
    assert.equal(receipt.requestAbortMs, 10000);
  }
});

test('original Task receipt rejection keeps signal exit and late receipt separate from confirmation', async () => {
  facts.beginFailureFixture();
  const originalFetch = globalThis.fetch;
  const cause = new Error(sentinel);
  const root = source('../e2e/recording-reliability.test.ts');
  const wrapper = find(
    root,
    (node) =>
      ts.isTryStatement(node) &&
      node.catchClause?.getText().includes('captureTaskReceiptFailure'),
  )[0];
  const f = {
    api,
    lab: 'private-id',
    messages: [{ event: 'armed' }],
    target: {
      evidence: '/task',
      child: { connected: false, exitCode: null, signalCode: 'SIGTERM' },
    },
  };
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.cookie, sentinel);
    f.messages.push({ event: 'fault-reached', prepared: sentinel });
    return new Response(
      JSON.stringify({
        status: url.includes('/tasks/') ? 'completed' : 'paused',
        result_id: 'private-id',
        revision: 7,
        ended_at: null,
      }),
      { status: 200 },
    );
  };
  try {
    const context = vm.createContext({
      ...facts,
      f,
      generation: facts.currentFailureGeneration(),
      path: '/device',
      command: { task_id: 'private-id' },
      machine: { session: { id: 'private-id' } },
      sessionPath: () => '/session',
      performance,
      recordingEventually: async (read, accepted, timeout) => {
        assert.equal(timeout, 20000);
        assert.equal(read(), undefined);
        assert.equal(accepted(undefined), false);
        throw cause;
      },
    });
    vm.runInContext(
      transpile(
        'async function run(){let reached;' +
          wrapper.getText() +
          ';return reached;}',
      ),
      context,
    );
    await assert.rejects(
      vm.runInContext('run()', context),
      (error) => error === cause,
    );
    const value = files.get('/task/test-failure-facts.json');
    assert.equal(requests, 2);
    assert.equal(value.atFailure.matchingReceiptCount, 0);
    assert.equal(value.atFailure.childExited, true);
    assert.equal(value.atFailure.childExitCode, null);
    assert.equal(value.postFailureReads[0].status, 'completed');
    assert.equal(value.postFailureReads[1].status, 'paused');
    safe(value);
    context.recordingEventually = async (read, accepted) => {
      const result = read();
      assert(accepted(result));
      return result;
    };
    const before = requests;
    await vm.runInContext('run()', context);
    assert.equal(requests, before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('startup observer separates owned spawn, actual health response and pre-request child exit', async () => {
  const root = source('../support/server-process.ts');
  const method = find(
    root,
    (node) => ts.isMethodDeclaration(node) && node.name.getText() === 'start',
  )[0];
  for (const mode of ['spawn', 'health', 'exit']) {
    facts.beginFailureFixture();
    const cause = new Error(sentinel);
    let requests = 0;
    const context = vm.createContext({
      ...facts,
      performance,
      AbortSignal,
      Error,
      fetch: async () => {
        requests++;
        return { status: 503, ok: false };
      },
      until: async (read, accepted) => {
        try {
          const response = await read();
          assert.equal(accepted(response), false);
        } catch {
          // The original startup waiter retains read errors until its deadline.
        }
        throw cause;
      },
    });
    vm.runInContext(
      transpile(
        'class Start { ' + method.getText() + ' };globalThis.Start=Start;',
      ),
      context,
    );
    const owner = new context.Start();
    owner.evidence = '/start-' + mode;
    owner.logs = sentinel;
    owner.assertOpen = () => {};
    owner.spawn = async () => {
      if (mode === 'spawn') throw cause;
      owner.child = {
        pid: 4,
        exitCode: mode === 'exit' ? 7 : null,
        signalCode: null,
      };
      owner.childProof = {};
    };
    await assert.rejects(owner.start(), (error) => error === cause);
    const value = files.get('/start-' + mode + '/test-failure-facts.json');
    assert.equal(
      value.phase,
      mode === 'spawn' ? 'owned-spawn-wait' : 'health-live-wait',
    );
    assert.equal(value.healthRequests, requests);
    if (mode === 'health') assert.equal(value.lastHealth.httpStatus, 503);
    if (mode === 'exit') {
      assert.equal(requests, 0);
      assert.equal(value.lastHealth.actualGetStarted, false);
      assert.equal(value.childExitCode, 7);
    }
    safe(value);
  }
});

test('session-authority recording waiter close retains ready or ACK phase and identical cause', async () => {
  const root = source('../server/session-authority.test.ts');
  const method = find(
    root,
    (node) =>
      ts.isMethodDeclaration(node) && node.name.getText() === 'exchange',
  )[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ status: 'interrupted', reason: 'machine_auth_timeout' }),
      { status: 200 },
    );
  try {
    for (const ready of [false, true]) {
      facts.beginFailureFixture();
      const cause = new Error(sentinel),
        readers = new WeakMap();
      const context = vm.createContext({
        ...facts,
        assert,
        performance,
        setTimeout,
        clearTimeout,
        WebSocket: { OPEN: 1 },
        failureReaders: readers,
      });
      vm.runInContext(
        transpile(
          'class Exchange { ' +
            method.getText() +
            ' };globalThis.Exchange=Exchange;',
        ),
        context,
      );
      const owner = new context.Exchange();
      owner.target = { evidence: '/exchange-' + ready };
      owner.failureGeneration = facts.currentFailureGeneration();
      owner.session = { id: 'private-id' };
      owner.failureRecordingScope = { recording_id: 'private-id' };
      owner.recordingReady = ready
        ? { limits: { retry_first_ms: 1, retry_second_ms: 2 } }
        : undefined;
      owner.recording = {
        readyState: 1,
        send() {
          queueMicrotask(() => owner.recordingWaiter.reject(cause));
        },
      };
      readers.set(owner.target, { client: api, base: '/lab' });
      await assert.rejects(
        owner.exchange('private-payload', performance.now() + 5000, false),
        (error) => error === cause,
      );
      const value = files.get(
        owner.target.evidence + '/test-failure-facts.json',
      );
      assert.equal(
        value.stage,
        ready ? 'recording-ack-failure' : 'recording-ready-failure',
      );
      assert.equal(value.reads[0].reason, 'machine_auth_timeout');
      safe(value);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('evidence writer failure never replaces original rejection', async () => {
  facts.beginFailureFixture();
  writeFails = true;
  try {
    await facts.captureStateFailure(
      facts.createStateFacts('running', 20),
      '/write-failed',
      new Error(sentinel),
    );
  } finally {
    writeFails = false;
  }
  assert.equal(files.has('/write-failed/test-failure-facts.json'), false);
});

test('disabled failure evidence performs no confirmation request or write', async () => {
  const previousFlag = process.env.TEST_FAILURE_FACTS;
  const previousFetch = globalThis.fetch;
  process.env.TEST_FAILURE_FACTS = '0';
  globalThis.fetch = () => {
    throw new Error('unexpected network request');
  };
  try {
    const disabled = await import(helperUrl + '?disabled');
    assert.equal(disabled.failureFactsEnabled, false);
    await disabled.captureRecordingFailure(
      api,
      '/session',
      '/recording',
      '/never-write',
      'control-failure',
    );
    assert.equal(files.has('/never-write/test-failure-facts.json'), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousFlag === undefined) delete process.env.TEST_FAILURE_FACTS;
    else process.env.TEST_FAILURE_FACTS = previousFlag;
  }
});

test('full-suite reconciliation uses actual ledgers and rejects active creator or consumer', async () => {
  const collectorUrl = new URL(
    '../support/reconcile-test-resources.ts',
    import.meta.url,
  ).href;
  for (const mode of ['clean', 'consumer', 'creator']) {
    let receipt;
    globalThis.__reconcileFixture = {
      existsSync: () => true,
      mkdirSync: () => {},
      readdirSync: () => ['lab-word-m1-A0'],
      readFileSync: () =>
        JSON.stringify({
          state: 'cleaned',
          directory: '',
          processes: [],
          inProcessConsumers: mode === 'consumer' ? [{}] : [],
          docker: [],
          creator: { pid: 1, executable: 'fake', start: '1' },
        }),
      writeFileSync: (_path, data) => {
        receipt = JSON.parse(data);
      },
      processIdentity: async () => (mode === 'creator' ? {} : null),
      sameProcess: () => true,
      recoverServerResources: async () => {
        throw new Error('unexpected recovery');
      },
    };
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        if (
          context.parentURL?.startsWith(collectorUrl) &&
          ['node:fs', './server-resources.ts'].includes(specifier)
        ) {
          const names =
            specifier === 'node:fs'
              ? [
                  'existsSync',
                  'mkdirSync',
                  'readdirSync',
                  'readFileSync',
                  'writeFileSync',
                ]
              : ['processIdentity', 'sameProcess', 'recoverServerResources'];
          return {
            url:
              'data:text/javascript,' +
              encodeURIComponent(
                names
                  .map(
                    (name) =>
                      `export const ${name}=(...args)=>globalThis.__reconcileFixture.${name}(...args);`,
                  )
                  .join('\n'),
              ),
            shortCircuit: true,
          };
        }
        return next(specifier, context);
      },
    });
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await import(collectorUrl + '?' + mode);
      assert.equal(receipt.actualOwnedLedgerCount, 1);
      assert.equal(receipt.resourcesClosed, mode === 'clean');
      assert.equal(process.exitCode, mode === 'clean' ? 0 : 1);
    } finally {
      hooks.deregister();
      process.exitCode = previousExitCode;
    }
  }
});
