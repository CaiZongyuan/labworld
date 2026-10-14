import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import {
  gateProjection,
  frontierRequestKind,
  observeFrontierTraffic,
  captureFrontierFailure,
  frontierDomConfirmation,
  originalMaskedCaptureFacts,
  originalMaskedCaptureDimensions,
  closedCategory,
} from '../e2e/browser-frontier-facts.ts';

const sentinel = 'credential-sentinel https://private.invalid/?token=secret';
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const parsed = (path) =>
  ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
function functionText(path, names) {
  return parsed(path)
    .statements.filter(
      (node) =>
        ts.isFunctionDeclaration(node) && names.includes(node.name?.text),
    )
    .map((node) => node.getText().replace(/^export /, ''))
    .join('\n');
}
function recordingHarness(writerFails = false) {
  let clock = 0;
  const receipts = [];
  const context = vm.createContext({
    performance: { now: () => clock },
    setTimeout: (fn, delay) => {
      assert.equal(delay, 20);
      clock += delay;
      fn();
    },
    recordingReceipt: (_name, value) => {
      if (writerFails) throw new Error(sentinel);
      receipts.push(value);
    },
  });
  vm.runInContext(
    ts.transpileModule(
      functionText('../e2e/recording-public-support.ts', [
        'recordingEventually',
        'recordingCompletionMetadata',
      ]),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  return { context, receipts };
}
const safe = (value) => {
  const serialized = JSON.stringify(value);
  for (const marker of [sentinel, 'https://', 'private.invalid', 'secret'])
    assert.equal(serialized.includes(marker), false);
};

test('actual frozen-image failure wrapper retains 200/409 appearance branches and the original equality cause', async () => {
  let wrapper;
  function visit(node) {
    if (
      ts.isTryStatement(node) &&
      node.tryBlock.statements[0]
        ?.getText()
        .startsWith('expect(afterAppearanceImage)')
    )
      wrapper = node;
    ts.forEachChild(node, visit);
  }
  visit(parsed('../e2e/lab-simulation-session.spec.ts'));
  assert(wrapper);
  for (const status of [200, 409])
    for (const writeFails of [false, true]) {
      const cause = new Error(sentinel);
      let receipt;
      const context = vm.createContext({
        performance,
        closedCategory,
        afterAppearanceImage: 'different',
        frozenImage: 'frozen',
        expect: (actual) => ({
          toBe: (expected) => {
            assert.equal(actual, 'different');
            assert.equal(expected, 'frozen');
            throw cause;
          },
        }),
        f: { second: {} },
        originalCaptures: [],
        attemptedAppearance: { status },
        appearanceRejected: status === 409,
        appearanceResult:
          status === 409
            ? { error: { code: 'lab.session_in_use', secret: sentinel } }
            : { secret: sentinel },
        pinnedAppearance: { green: 100, purple: 0 },
        originalMaskedCaptureFacts: async () => ({
          status: 'timeout',
          elapsedMs: 250,
        }),
        originalMaskedCaptureDimensions: () => [{ width: 1440, height: 1000 }],
        receipt: (_name, value) => {
          receipt = value;
          if (writeFails) throw new Error(sentinel);
        },
      });
      vm.runInContext(
        ts.transpileModule('async function run(){' + wrapper.getText() + '}', {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        context,
      );
      await assert.rejects(
        vm.runInContext('run()', context),
        (error) => error === cause,
      );
      assert.equal(receipt.originalHttpStatus, status);
      assert.equal(receipt.appearanceRejected, status === 409);
      assert.equal(
        receipt.originalErrorCode,
        status === 409 ? 'lab.session_in_use' : null,
      );
      assert.equal(receipt.originalAppearanceEqualityPassed, false);
      safe(receipt);
    }
});

test('Recording preserves first original poll, first terminal cause and distinct last poll without accepting incomplete', async () => {
  const { context, receipts } = recordingHarness();
  const values = [
    { status: 'open', reason: null },
    { status: 'incomplete', reason: 'recording_ack_timeout' },
    { status: 'incomplete', reason: 'recording_seal_failed' },
  ];
  let requests = 0;
  await assert.rejects(
    context.recordingEventually(
      () => ({ ...values[requests++], credential: sentinel }),
      (value) => value.status === 'complete',
      60,
      'A',
    ),
  );
  assert.equal(requests, 3);
  const receipt = receipts[0];
  assert.equal(receipt.outcome, 'timeout');
  assert.equal(receipt.firstOriginalPoll.metadata.status, 'open');
  assert.equal(receipt.firstOriginalTerminal.poll, 2);
  assert.equal(
    receipt.firstOriginalTerminal.metadata.reason,
    'recording_ack_timeout',
  );
  assert.equal(receipt.last.reason, 'recording_seal_failed');
  assert.equal(receipt.originalTimeoutMs, 60);
  safe(receipt);
});

test('Recording projection recognizes source-confirmed causes and preserves unknown without raw strings', () => {
  const { context } = recordingHarness();
  const producers = [
    '../../packages/server/src/lab/recordings/service.ts',
    '../../packages/server/src/lab/recordings/journal.ts',
    '../../packages/server/src/lab/sessions/service.ts',
  ]
    .map(source)
    .join('\n');
  for (const reason of [
    'recording_seal_timeout',
    'recording_sequence_gap',
    'recording_event_commit_timeout',
    'recording_corrupt_tail',
    'publisher_disconnected',
    'machine_auth_timeout',
  ]) {
    assert(producers.includes("'" + reason + "'"));
    assert.equal(
      context.recordingCompletionMetadata({ reason }).reason,
      reason,
    );
  }
  assert.equal(
    context.recordingCompletionMetadata({
      reason: 'Recording operation deadline reached',
    }).reason,
    'recording_operation_deadline',
  );
  const unknown = context.recordingCompletionMetadata({
    reason: sentinel,
    status: sentinel,
    prefix: { last_source_sequence: sentinel },
  });
  assert.equal(unknown.reason, 'unknown');
  assert.equal(unknown.sourceFrames, null);
  safe(unknown);
});

test('Recording read and predicate errors remain the exact original causes when evidence writes fail', async () => {
  for (const stage of ['read', 'predicate']) {
    const { context } = recordingHarness(true);
    const cause = new Error(sentinel);
    await assert.rejects(
      context.recordingEventually(
        () => {
          if (stage === 'read') throw cause;
          return { status: 'open' };
        },
        () => {
          throw cause;
        },
        10000,
        'A',
      ),
      (error) => error === cause,
    );
  }
});

test('public entity and program projections retain branch and capability gates with closed fields', () => {
  const entity = {
    id: sentinel,
    task: { status: 'running' },
    binding: { id: sentinel },
    program_run: { status: 'running', id: sentinel },
    capabilities: [
      {
        id: 'centrifuge.start',
        binding_implemented: false,
        executable: false,
        reason: 'binding_not_implemented',
        secret: sentinel,
      },
    ],
  };
  const facts = gateProjection(
    { entities: [entity], version: '7', secret: sentinel },
    sentinel,
    'world',
  );
  assert.equal(facts.taskStatus, 'running');
  assert.equal(facts.programStatus, 'running');
  assert.equal(facts.bindingImplemented, false);
  assert.equal(facts.executable, false);
  assert.equal(facts.worldVersion, 7);
  safe(facts);
  const rejected = gateProjection(
    { error: { code: 'lab.runtime_unavailable', message: sentinel } },
    sentinel,
    'start',
  );
  assert.equal(rejected.errorCode, 'lab.runtime_unavailable');
  safe(rejected);
});

test('passive traffic preserves original status and keeps a late body projection separate after stop', async () => {
  const page = new EventEmitter();
  const observer = observeFrontierTraffic(
    page,
    '/api/v1/lab/labs/private',
    sentinel,
  );
  const cleanRequest = {
    url: () => 'https://private.invalid/api/v1/lab/labs/private/world',
    method: () => 'GET',
  };
  let release;
  const bytes = new Promise((resolve) => {
    release = resolve;
  });
  page.emit('request', cleanRequest);
  page.emit('response', {
    request: () => cleanRequest,
    status: () => 200,
    body: () => bytes,
  });
  const frozen = observer.stop();
  assert.equal(frozen.originalCallbackFacts[0].httpStatus, 200);
  assert.equal(frozen.originalCallbackFacts[0].projection, null);
  assert.equal(page.listenerCount('response'), 0);
  release(Buffer.from(JSON.stringify({ version: '8', secret: sentinel })));
  const later = await frozen.postFailureOriginalResponseReadback();
  assert.equal(later[0].projection.status, 'ack');
  assert.equal(later[0].projection.value.worldVersion, 8);
  assert.equal(frozen.originalCallbackFacts[0].projection, null);
  safe(frozen.originalCallbackFacts);
  safe(later);
});

test('traffic classifies World stream, model and object paths without retaining paths or credentials', () => {
  const base = '/api/v1/lab/labs/private';
  for (const [path, kind] of [
    [base + '/world', 'world'],
    [base + '/world/subscribe', 'world-stream'],
    ['/objects/secret', 'object'],
    ['/api/v1/lab/assets/private/download', 'asset-download'],
    ['/lab-assets/decoders/draco.wasm', 'model'],
  ])
    assert.equal(frontierRequestKind(path, 'GET', base, ''), kind);
  assert.equal(
    frontierRequestKind('/api/v1/auth/session', 'GET', base, ''),
    null,
  );
  const page = new EventEmitter();
  const observer = observeFrontierTraffic(page, base);
  for (let n = 0; n < 70; n++)
    page.emit('request', {
      url: () => 'https://private.invalid' + base + '/world',
      method: () => 'GET',
    });
  const stopped = observer.stop();
  assert.equal(stopped.originalCallbackFacts.length, 64);
  assert.equal(stopped.dropped, 6);
  safe(stopped.originalCallbackFacts);
});

test('DOM confirmation closes arbitrary labels and captures the later disabled/busy facts without private state', async () => {
  const unknown = { textContent: sentinel };
  const root = {
    getAttribute: () => 'true',
    querySelector: () => unknown,
    querySelectorAll: () => [],
  };
  unknown.querySelector = () => unknown;
  unknown.querySelectorAll = () => [];
  const page = {
    evaluate: (fn) =>
      Promise.resolve(
        vm.runInContext(
          '(' + fn.toString() + ')()',
          vm.createContext({
            document: { querySelector: () => root },
            performance,
          }),
        ),
      ),
  };
  const confirmation = await frontierDomConfirmation(page);
  assert.equal(confirmation.status, 'ack');
  assert.equal(confirmation.value.busy, true);
  assert.equal(confirmation.value.programStatus, 'unknown');
  assert.equal(confirmation.value.privateLockFactorsKnown, false);
  safe(confirmation);
});

test('failure capture writes closed facts and tolerates missing output while assertions keep their cause', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-frontier-synthetic-'));
  const previous = process.env.LAB_NODE_EVIDENCE;
  process.env.LAB_NODE_EVIDENCE = directory;
  const page = { evaluate: async () => ({ busy: true, startDisabled: true }) };
  const observed = {
    atFailureMs: 7,
    originalCallbackFacts: [{ kind: 'start', httpStatus: 503 }],
    dropped: 0,
    postFailureOriginalResponseReadback: async () => [],
  };
  try {
    await captureFrontierFailure('centrifuge-enabled', page, observed);
    const receipt = JSON.parse(
      readFileSync(
        join(directory, 'browser-centrifuge-enabled-failure.json'),
        'utf8',
      ),
    );
    assert.equal(receipt.originalTimeoutMs, 5000);
    assert.equal(receipt.originalCallbackFacts[0].httpStatus, 503);
    assert.equal(receipt.postFailureDomConfirmation.value.startDisabled, true);
    safe(receipt);
    process.env.LAB_NODE_EVIDENCE = join(directory, 'absent');
    await captureFrontierFailure('centrifuge-enabled', page, observed);
  } finally {
    if (previous === undefined) delete process.env.LAB_NODE_EVIDENCE;
    else process.env.LAB_NODE_EVIDENCE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('original PNG dimensions survive browser decode unavailability and malformed bytes stay unknown', async () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(1440, 16);
  png.writeUInt32BE(1000, 20);
  const captures = [png, Buffer.from(sentinel)];
  const dimensions = originalMaskedCaptureDimensions(captures);
  assert.deepEqual(dimensions, [
    { width: 1440, height: 1000 },
    { width: null, height: null },
  ]);
  const decode = await originalMaskedCaptureFacts(
    {
      evaluate: async () => {
        throw new Error(sentinel);
      },
    },
    captures,
  );
  assert.equal(decode.status, 'error');
  assert.deepEqual(originalMaskedCaptureDimensions(captures), dimensions);
  safe(dimensions);
  safe(decode);
});

test('color decoding consumes supplied original captures and returns only dimensions and masked pixel counts', async () => {
  const captures = [
    Buffer.from('synthetic-green'),
    Buffer.from('synthetic-purple'),
  ];
  const rasters = new Map(
    captures.map((bytes, index) => [
      'data:image/png;base64,' + bytes.toString('base64'),
      new Uint8ClampedArray(index ? [120, 0, 120, 255] : [0, 100, 0, 255]),
    ]),
  );
  const context = vm.createContext({
    Image: class {
      width = 1;
      height = 1;
      async decode() {}
    },
    document: {
      createElement: () => {
        let image;
        return {
          getContext: () => ({
            drawImage: (value) => {
              image = value;
            },
            getImageData: () => ({ data: rasters.get(image.src) }),
          }),
        };
      },
    },
  });
  const page = {
    evaluate: (fn, encoded) => {
      context.encoded = encoded;
      return vm.runInContext('(' + fn.toString() + ')(encoded)', context);
    },
  };
  const result = await originalMaskedCaptureFacts(page, captures);
  assert.equal(result.status, 'ack');
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), [
    { width: 1, height: 1, green: 1, purple: 0 },
    { width: 1, height: 1, green: 0, purple: 1 },
  ]);
  safe(result);
});

test('four call sites preserve original assertions, deadlines and screenshot count; observers send no requests', () => {
  const recording = source('../e2e/lab-recording.spec.ts');
  assert.match(recording, /value\.status === 'complete',\s*10000,/);
  const session = source('../e2e/lab-simulation-session.spec.ts');
  assert(
    session.indexOf('expect(afterAppearanceImage).toBe(frozenImage)') <
      session.indexOf('originalMaskedCaptureFacts(f.second, originalCaptures)'),
  );
  assert.match(session, /\[200, 409\]/);
  assert.equal(
    (
      source('../e2e/simulation-session-support.ts')
        .match(/export async function maskedCanvas[\s\S]*?\.digest\('hex'\)/)[0]
        .match(/\.screenshot\(/g) ?? []
    ).length,
    1,
  );
  const records = source('../e2e/lab-records.spec.ts');
  assert.match(
    records,
    /getByRole\('button', \{ name: '开始离心', exact: true \}\),\s*\)\.toBeEnabled\(\)/,
  );
  const readiness = source('../e2e/lab-render-metric-readiness.spec.ts');
  const failureCapture = readiness.search(
    /captureFrontierFailure\(\s*'initial-render-ready'/,
  );
  assert(failureCapture >= 0);
  assert(failureCapture < readiness.indexOf('renderStreamGate.held = true'));
  assert.match(readiness, /held: false/);
  const helper = source('../e2e/browser-frontier-facts.ts');
  assert.equal(
    /\bfetch\(|\.screenshot\(|page\.request|__react|ReactFiber/.test(helper),
    false,
  );
  assert.equal(typeof originalMaskedCaptureFacts, 'function');
});
