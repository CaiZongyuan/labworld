import type { CDPSession, Page, TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Complete, TraceOwner } from './lab-frame-trace-project';

const categories =
  'toplevel,devtools.timeline,disabled-by-default-devtools.timeline';
type MarkName =
  | 'start-response'
  | 'assertion-start'
  | 'world-parsed'
  | 'hdr-response'
  | 'assertion-end'
  | 'ack-capture-end';
type TraceFile =
  | 'centrifuge-start-frame-trace.json'
  | 'light-start-frame-trace.json'
  | 'observer-readiness-frame-trace.json'
  | 'workbench-readiness-frame-trace.json';
async function deadline<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Trace deadline')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Identity = {
  frame: string;
  loaderId: string;
  path: string;
  nodeMs: number;
  generation: number;
};
const documentPath = (url: string) => {
  try {
    const path = new URL(url).pathname;
    return ['/lab', '/register', '/login'].includes(path) ? path : '<REDACTED>';
  } catch {
    return '<REDACTED>';
  }
};
const documentToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{16,80}$/i.test(value);
// Diagnostic state from the owned Page/CDP session, never renderer internals.
export class DocumentIdentity {
  coverage = false;
  coverageStartedMs = 0;
  generation = 0;
  current?: Omit<Identity, 'nodeMs' | 'generation'>;
  eligible?: Identity;
  changes: { nodeMs: number; generation: number; kind: string }[] = [];
  attempts: {
    nodeMs: number;
    generation: number;
    status: 'ack' | 'unavailable' | 'rejected';
  }[] = [];
  enable(nodeMs: number) {
    if (this.changes.some((change) => change.kind !== 'navigation')) return;
    this.coverage = true;
    this.coverageStartedMs = nodeMs;
  }
  private change(kind: string, nodeMs: number) {
    this.generation++;
    this.eligible = undefined;
    if (this.changes.length < 64)
      this.changes.push({ nodeMs, generation: this.generation, kind });
    else this.coverage = false;
  }
  navigate(
    frame: { id: string; loaderId?: string; url: string },
    nodeMs: number,
  ) {
    this.change('navigation', nodeMs);
    this.current =
      documentToken(frame.id) && documentToken(frame.loaderId)
        ? {
            frame: frame.id,
            loaderId: frame.loaderId,
            path: documentPath(frame.url),
          }
        : undefined;
  }
  lose(kind: string, nodeMs: number) {
    this.change(kind, nodeMs);
    this.coverage = false;
    this.current = undefined;
  }
  accept(
    frame: { id: string; loaderId?: string; url: string },
    generation: number,
    nodeMs: number,
  ) {
    const candidate = {
      frame: frame.id,
      loaderId: frame.loaderId,
      path: documentPath(frame.url),
    };
    const valid =
      this.coverage &&
      generation === this.generation &&
      documentToken(candidate.frame) &&
      documentToken(candidate.loaderId) &&
      candidate.path === '/lab' &&
      (!this.current ||
        (this.current.frame === candidate.frame &&
          this.current.loaderId === candidate.loaderId &&
          this.current.path === candidate.path));
    this.attempt(valid ? 'ack' : 'rejected', generation, nodeMs);
    if (!valid) {
      if (
        generation === this.generation &&
        (this.eligible || this.current?.path === '/lab')
      )
        this.lose('ambiguous-ack', nodeMs);
      return;
    }
    this.current = candidate as NonNullable<DocumentIdentity['current']>;
    this.eligible = { ...this.current, nodeMs, generation };
  }
  attempt(
    status: 'ack' | 'unavailable' | 'rejected',
    generation: number,
    nodeMs: number,
  ) {
    if (this.attempts.length < 64)
      this.attempts.push({ status, generation, nodeMs });
    else this.lose('attempt-overflow', nodeMs);
  }
  snapshot() {
    return {
      coverage: this.coverage,
      coverageStartedMs: this.coverageStartedMs,
      generation: this.generation,
      eligible: this.eligible,
      changes: [...this.changes],
      attempts: [...this.attempts],
    };
  }
}

const owned = new WeakMap<TestInfo, Set<FrameTrace>>();

class FrameTrace {
  private enabled = process.env.LAB_WORD_FRAME_TRACE === 'true';
  private worker?: Worker;
  private sessions = new Set<CDPSession>();
  private browserSession?: CDPSession;
  private complete?: Promise<Complete>;
  private pageSessions = new Map<Page, Promise<CDPSession>>();
  private documents = new Map<Page, DocumentIdentity>();
  private closed = false;
  private finishPromise?: Promise<void>;
  private armed = false;
  private startIssued = false;
  private startPromise?: Promise<unknown>;
  private startConfirmed = false;
  private endConfirmed = false;
  private terminalReceived = false;
  private streamCloseConfirmed = false;
  private workerTerminated: boolean | 'not-started' = 'not-started';
  private clockBeforeMs?: number;
  private clockAfterMs?: number;
  private marks: { name: MarkName; nodeMs: number }[] = [];
  private omittedMarks = 0;
  private startedMs = performance.now();

  constructor(
    private page: Page,
    private file: TraceFile,
    private otherPages: Page[],
  ) {}

  private async session(create: () => Promise<CDPSession>) {
    const session = await create();
    if (this.closed) {
      void session.detach().catch(() => {});
      throw new Error('Trace owner closed');
    }
    this.sessions.add(session);
    return session;
  }

  private pageSession(page: Page) {
    let pending = this.pageSessions.get(page);
    if (!pending) {
      const identity = new DocumentIdentity();
      this.documents.set(page, identity);
      pending = this.session(() => page.context().newCDPSession(page)).then(
        async (session) => {
          session.on('Page.frameNavigated', ({ frame }) => {
            if (!frame.parentId) identity.navigate(frame, performance.now());
          });
          session.on('Page.navigatedWithinDocument', ({ frameId, url }) => {
            if (
              identity.current?.frame === frameId &&
              documentPath(url) !== identity.current.path
            )
              identity.lose('path-change', performance.now());
          });
          session.on('Page.frameDetached', ({ frameId }) => {
            if (!identity.current || identity.current.frame === frameId)
              identity.lose('frame-detached', performance.now());
          });
          session.on('Inspector.detached', () =>
            identity.lose('inspector-detached', performance.now()),
          );
          session.on('close', () =>
            identity.lose('session-closed', performance.now()),
          );
          await session.send('Page.enable');
          if (!this.closed) identity.enable(performance.now());
          return session;
        },
      );
      this.pageSessions.set(page, pending);
    }
    return pending;
  }

  async captureActiveDocuments() {
    if (!this.enabled) return;
    await Promise.all(
      [this.page, ...this.otherPages].map(async (page) => {
        let identity: DocumentIdentity | undefined;
        let generation = -1;
        try {
          const pending = this.pageSession(page);
          identity = this.documents.get(page)!;
          const session = await deadline(pending, 250);
          generation = identity.generation;
          const tree = await deadline(session.send('Page.getFrameTree'), 250);
          identity.accept(tree.frameTree.frame, generation, performance.now());
        } catch {
          identity?.attempt('unavailable', generation, performance.now());
        }
      }),
    );
  }

  async arm() {
    if (!this.enabled) return;
    try {
      await deadline(
        (async () => {
          const browser = this.page.context().browser();
          if (!browser) throw new Error('No browser control');
          const session = await this.session(() =>
            browser.newBrowserCDPSession(),
          );
          this.browserSession = session;
          this.complete = new Promise<Complete>((resolve) => {
            session.once('Tracing.tracingComplete', (terminal: Complete) => {
              this.terminalReceived = true;
              if (this.closed && terminal.stream)
                void this.closeStream(terminal.stream);
              resolve(terminal);
            });
          });
          await this.captureActiveDocuments();
          if (this.closed) return;
          this.startIssued = true;
          this.startPromise = session.send('Tracing.start', {
            categories,
            transferMode: 'ReturnAsStream',
            streamFormat: 'json',
          });
          await this.startPromise;
          this.startConfirmed = true;
          if (this.closed) {
            void session.send('Tracing.end').catch(() => {});
            return;
          }
          this.armed = true;
          this.clockBeforeMs = performance.now();
          await session.send('Tracing.recordClockSyncMarker', {
            syncId: 'owned-frame-trace',
          });
          this.clockAfterMs = performance.now();
        })(),
        1000,
      );
    } catch {
      this.closed = true;
      if (this.startPromise)
        await deadline(
          this.startPromise.then(() => {
            this.startConfirmed = true;
          }),
          250,
        ).catch(() => {});
      if (this.startIssued && this.browserSession)
        await deadline(
          this.browserSession.send('Tracing.end').then(() => {
            this.endConfirmed = true;
          }),
          250,
        ).catch(() => {});
      await this.closeTerminal();
      await this.detach();
    }
  }

  mark(name: MarkName) {
    if (this.marks.length < 64)
      this.marks.push({ name, nodeMs: performance.now() });
    else this.omittedMarks++;
  }

  private async detach() {
    await Promise.all(
      [...this.sessions].map((session) =>
        deadline(session.detach(), 250).catch(() => {}),
      ),
    );
  }

  private async closeStream(handle: string) {
    await this.browserSession
      ?.send('IO.close', { handle })
      .then(() => {
        this.streamCloseConfirmed = true;
      })
      .catch(() => {});
  }

  private async closeTerminal() {
    if (this.complete)
      await deadline(
        this.complete.then((terminal) =>
          terminal.stream ? this.closeStream(terminal.stream) : undefined,
        ),
        250,
      ).catch(() => {});
  }

  finish(save: boolean) {
    this.finishPromise ??= this.stop(save);
    return this.finishPromise;
  }

  private async stop(save: boolean) {
    let facts: Record<string, unknown> = this.enabled
      ? { status: 'not-armed' }
      : { status: 'disabled', marks: this.marks };
    let live = true;
    try {
      if (this.armed && this.browserSession && this.complete) {
        const session = this.browserSession;
        const complete = this.complete;
        const terminal = await deadline(
          (async () => {
            await session.send('Tracing.end');
            this.endConfirmed = true;
            return complete;
          })(),
          save ? 8000 : 2500,
        );
        facts = await deadline(
          (async () => {
            if (!terminal.stream) return { status: 'missing-stream' };
            if (!live) {
              void this.closeStream(terminal.stream);
              return { status: 'late-stream' };
            }
            try {
              if (!save) return { status: 'discarded' };
              const chunks: string[] = [];
              let bytes = 0;
              let eof = false;
              while (live && !eof) {
                const chunk = await session.send('IO.read', {
                  handle: terminal.stream,
                });
                if (!live) return { status: 'read-deadline' };
                const text = chunk.base64Encoded
                  ? Buffer.from(chunk.data, 'base64').toString('utf8')
                  : chunk.data;
                bytes += Buffer.byteLength(text);
                if (bytes > 32 * 1024 * 1024)
                  return { status: 'size-truncated', bytes };
                chunks.push(text);
                eof = !!chunk.eof;
              }
              if (!live) return { status: 'read-deadline' };
              return this.project(chunks.join(''), terminal, bytes);
            } finally {
              void this.closeStream(terminal.stream);
            }
          })(),
          2500,
        );
      }
    } catch {
      facts = { status: 'stop-or-read-incomplete' };
    } finally {
      live = false;
      this.closed = true;
      await this.closeTerminal();
      await this.detach();
      if (this.worker) {
        this.workerTerminated = false;
        await deadline(this.worker.terminate(), 250)
          .then(() => {
            this.workerTerminated = true;
          })
          .catch(() => {});
      }
    }
    if (save) {
      try {
        writeFileSync(
          join(process.env.LAB_NODE_EVIDENCE!, this.file),
          JSON.stringify({
            ...facts,
            startedMs: this.startedMs,
            endedMs: performance.now(),
            rawTraceSaved: false,
            omittedMarks: this.omittedMarks,
            cleanup: {
              startIssued: this.startIssued,
              startConfirmed: this.startConfirmed,
              endConfirmed: this.endConfirmed,
              terminalReceived: this.terminalReceived,
              streamCloseConfirmed: this.streamCloseConfirmed,
              workerTerminated: this.workerTerminated,
            },
          }) + '\n',
          { mode: 0o600 },
        );
      } catch {
        // Optional trace evidence cannot replace the original assertion failure.
      }
    }
  }

  private project(text: string, terminal: Complete, bytes: number) {
    const owner: TraceOwner = {
      clockBeforeMs: this.clockBeforeMs,
      clockAfterMs: this.clockAfterMs,
      marks: this.marks,
      targetFrame: this.documents.get(this.page)?.eligible?.frame,
      otherFrames: this.otherPages.map(
        (page) => this.documents.get(page)?.eligible?.frame,
      ),
      otherPageCount: this.otherPages.length,
      activeDocuments: {
        status: this.documents.get(this.page)?.eligible ? 'ack' : 'unavailable',
        frames: [this.page, ...this.otherPages].map(
          (page) => this.documents.get(page)?.eligible ?? null,
        ),
      },
      documentIdentities: [this.page, ...this.otherPages].map(
        (page) => this.documents.get(page)?.snapshot() ?? null,
      ),
      repoRoot: process.cwd(),
    };
    const worker = new Worker(
      new URL('./lab-frame-trace-project.ts', import.meta.url),
      {
        workerData: { text, terminal, bytes, owner },
        execArgv: ['--experimental-strip-types'],
      },
    );
    this.worker = worker;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', () => reject(new Error('Trace projection failed')));
      worker.once('exit', () => reject(new Error('Trace projection exited')));
    });
  }
}

export async function startFrameTrace(
  page: Page,
  file: TraceFile,
  info: TestInfo,
  otherPages: Page[] = [],
) {
  const trace = new FrameTrace(page, file, otherPages);
  const traces = owned.get(info) ?? new Set<FrameTrace>();
  traces.add(trace);
  owned.set(info, traces);
  await trace.arm();
  return trace;
}

export async function releaseFrameTraces(
  { page }: { page: Page },
  info: TestInfo,
) {
  void page;
  await Promise.all(
    [...(owned.get(info) ?? [])].map((trace) => trace.finish(false)),
  );
  owned.delete(info);
}
