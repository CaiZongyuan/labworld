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
const { startFrameTrace, releaseFrameTraces } = await import(
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
