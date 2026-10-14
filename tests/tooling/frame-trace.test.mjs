import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(
  new URL('../e2e/lab-frame-trace.ts', import.meta.url),
  'utf8',
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { startFrameTrace, releaseFrameTraces, DocumentIdentity } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

async function configured(value, run) {
  const previous = process.env.LAB_WORD_FRAME_TRACE;
  if (value === undefined) delete process.env.LAB_WORD_FRAME_TRACE;
  else process.env.LAB_WORD_FRAME_TRACE = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.LAB_WORD_FRAME_TRACE;
    else process.env.LAB_WORD_FRAME_TRACE = previous;
  }
}

test('default trace makes no browser calls and retains an explicit disabled receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-disabled-trace-'));
  const previous = process.env.LAB_NODE_EVIDENCE;
  process.env.LAB_NODE_EVIDENCE = directory;
  try {
    for (const value of [undefined, 'false', '1']) {
      await configured(value, async () => {
        let calls = 0;
        const page = {
          context() {
            calls++;
            throw new Error('Disabled trace must not access browser control');
          },
        };
        const info = {};
        const trace = await startFrameTrace(
          page,
          'observer-readiness-frame-trace.json',
          info,
          [page],
        );
        trace.mark('assertion-start');
        await trace.captureActiveDocuments();
        trace.mark('assertion-end');
        await trace.finish(true);
        await releaseFrameTraces({ page }, info);
        assert.equal(calls, 0);
        const receipt = JSON.parse(
          await readFile(
            join(directory, 'observer-readiness-frame-trace.json'),
          ),
        );
        assert.equal(receipt.status, 'disabled');
        assert.deepEqual(
          receipt.marks.map(({ name }) => name),
          ['assertion-start', 'assertion-end'],
        );
        assert.equal(receipt.rawTraceSaved, false);
        assert.equal(receipt.cleanup.startIssued, false);
        assert.equal(receipt.cleanup.workerTerminated, 'not-started');
      });
    }
  } finally {
    if (previous === undefined) delete process.env.LAB_NODE_EVIDENCE;
    else process.env.LAB_NODE_EVIDENCE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit true retains trace dispatch and owned stop/detach', async () => {
  await configured('true', async () => {
    const commands = [];
    const detached = [];
    let browserSessions = 0;
    let pageSessions = 0;
    class Session extends EventEmitter {
      constructor(role) {
        super();
        this.role = role;
      }
      async send(command, parameters) {
        commands.push({ role: this.role, command, parameters });
        if (command === 'Page.getFrameTree')
          return {
            frameTree: {
              frame: {
                id: '1111111111111111',
                loaderId: '2222222222222222',
                url: 'http://fixture/lab',
              },
            },
          };
        if (command === 'Tracing.end')
          this.emit('Tracing.tracingComplete', { stream: 'owned-fixture' });
        return {};
      }
      async detach() {
        detached.push(this.role);
      }
    }
    const browser = {
      async newBrowserCDPSession() {
        browserSessions++;
        return new Session('browser');
      },
    };
    const context = {
      browser: () => browser,
      async newCDPSession() {
        pageSessions++;
        return new Session('page');
      },
    };
    const page = { context: () => context };
    const info = {};
    const trace = await startFrameTrace(
      page,
      'observer-readiness-frame-trace.json',
      info,
    );
    process.env.LAB_WORD_FRAME_TRACE = 'false';
    await trace.captureActiveDocuments();
    await trace.finish(false);
    await releaseFrameTraces({ page }, info);
    assert.equal(browserSessions, 1);
    assert.equal(pageSessions, 1);
    assert.equal(
      commands.filter(({ command }) => command === 'Tracing.start').length,
      1,
    );
    assert.equal(
      commands.filter(({ command }) => command === 'Tracing.end').length,
      1,
    );
    assert.equal(
      commands.filter(({ command }) => command === 'Page.getFrameTree').length,
      2,
    );
    assert.ok(commands.some(({ command }) => command === 'IO.close'));
    assert.ok(
      commands.some(
        ({ command }) => command === 'Tracing.recordClockSyncMarker',
      ),
    );
    assert.deepEqual(detached.sort(), ['browser', 'page']);
  });
});

const projectionSource = await readFile(
  new URL('../e2e/lab-frame-trace-project.ts', import.meta.url),
  'utf8',
);
const projectionCode = ts.transpileModule(projectionSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { projectTrace } = await import(
  `data:text/javascript;base64,${Buffer.from(projectionCode).toString('base64')}`
);
const targetFrame = '1111111111111111';
function projectionOwner(identity) {
  return {
    clockBeforeMs: 10,
    clockAfterMs: 10,
    marks: [
      { name: 'assertion-start', nodeMs: 100 },
      { name: 'assertion-end', nodeMs: 200 },
    ],
    targetFrame,
    otherFrames: [],
    otherPageCount: 0,
    activeDocuments: {
      status: 'ack',
      frames: [
        {
          frame: targetFrame,
          loaderId: '2222222222222222',
          path: '/lab',
          nodeMs: 90,
        },
      ],
    },
    documentIdentities: [identity],
  };
}
const identityEvents = [
  {
    name: 'clock_sync',
    pid: 1,
    tid: 1,
    ts: 10000,
    args: { sync_id: 'owned-frame-trace' },
  },
  {
    name: 'thread_name',
    ph: 'M',
    pid: 42,
    tid: 7,
    ts: 0,
    args: { name: 'CrRendererMain' },
  },
  {
    name: 'TracingStartedInBrowser',
    pid: 1,
    tid: 1,
    ts: 0,
    args: { data: { frames: [{ frame: targetFrame, processId: 42 }] } },
  },
];
test('same frame and renderer with a new document during assertion cannot be attributed', () => {
  const owner = projectionOwner({
    coverage: true,
    coverageStartedMs: 0,
    generation: 1,
    eligible: {
      frame: targetFrame,
      loaderId: '3333333333333333',
      path: '/lab',
      generation: 1,
      nodeMs: 180,
    },
    changes: [{ nodeMs: 150, generation: 1, kind: 'navigation' }],
  });
  owner.activeDocuments.frames[0].loaderId = '3333333333333333';
  const result = projectTrace(identityEvents, {}, 100, owner);
  assert.equal(result.mapping.status, 'unknown');
  assert.equal(result.clock.mapped, true);
});

function verifiedDocument() {
  const identity = new DocumentIdentity();
  identity.enable(0);
  identity.accept(
    {
      id: targetFrame,
      loaderId: '2222222222222222',
      url: 'http://fixture/lab',
    },
    0,
    90,
  );
  return identity;
}
test('later unavailable capture retains only a verified unchanged document', () => {
  const identity = verifiedDocument();
  identity.attempt('unavailable', 0, 170);
  const result = projectTrace(
    identityEvents,
    {},
    100,
    projectionOwner(identity.snapshot()),
  );
  assert.equal(result.mapping.status, 'mapped-target-frame');
  assert.equal(
    result.documentIdentities[0].attempts.at(-1).status,
    'unavailable',
  );
});
test('real navigation invalidates an ACK and a stale generation cannot replace it', () => {
  const identity = verifiedDocument();
  identity.navigate(
    {
      id: targetFrame,
      loaderId: '3333333333333333',
      url: 'http://fixture/lab',
    },
    150,
  );
  identity.accept(
    {
      id: targetFrame,
      loaderId: '2222222222222222',
      url: 'http://fixture/lab',
    },
    0,
    160,
  );
  assert.equal(identity.eligible, undefined);
  identity.accept(
    {
      id: targetFrame,
      loaderId: '3333333333333333',
      url: 'http://fixture/lab',
    },
    1,
    180,
  );
  const owner = projectionOwner(identity.snapshot());
  owner.activeDocuments.frames[0].loaderId = '3333333333333333';
  assert.equal(
    projectTrace(identityEvents, {}, 100, owner).mapping.status,
    'unknown',
  );
});
test('blank, nonlab, missing loader, detach and lost coverage cannot grant attribution', () => {
  for (const url of ['about:blank', 'http://fixture/login']) {
    const identity = verifiedDocument();
    identity.navigate(
      { id: targetFrame, loaderId: '3333333333333333', url },
      150,
    );
    identity.accept(
      { id: targetFrame, loaderId: '3333333333333333', url },
      1,
      160,
    );
    assert.equal(
      projectTrace(
        identityEvents,
        {},
        100,
        projectionOwner(identity.snapshot()),
      ).mapping.status,
      'unknown',
    );
  }
  for (const reason of ['frame-detached', 'session-closed', 'coverage-lost']) {
    const identity = verifiedDocument();
    identity.lose(reason, 150);
    assert.equal(
      projectTrace(
        identityEvents,
        {},
        100,
        projectionOwner(identity.snapshot()),
      ).mapping.status,
      'unknown',
    );
  }
  const empty = new DocumentIdentity();
  empty.enable(0);
  empty.accept(
    { id: targetFrame, loaderId: '', url: 'http://fixture/lab' },
    0,
    90,
  );
  empty.attempt('unavailable', 0, 170);
  assert.equal(
    projectTrace(identityEvents, {}, 100, projectionOwner(empty.snapshot()))
      .mapping.status,
    'unknown',
  );
});

test('a document first acknowledged after the assertion cannot identify its earlier frame', () => {
  const identity = new DocumentIdentity();
  identity.enable(0);
  identity.navigate(
    {
      id: targetFrame,
      loaderId: '3333333333333333',
      url: 'http://fixture/lab',
    },
    250,
  );
  identity.accept(
    {
      id: targetFrame,
      loaderId: '3333333333333333',
      url: 'http://fixture/lab',
    },
    1,
    260,
  );
  const owner = projectionOwner(identity.snapshot());
  owner.activeDocuments.frames[0].loaderId = '3333333333333333';
  assert.equal(
    projectTrace(identityEvents, {}, 100, owner).mapping.status,
    'unknown',
  );
});
