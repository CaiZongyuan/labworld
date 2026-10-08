import type { CDPSession, Page, TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Complete, TraceOwner } from './lab-frame-trace-project';

const categories =
  'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler';
type MarkName =
  | 'start-response'
  | 'world-parsed'
  | 'hdr-response'
  | 'assertion-end'
  | 'ack-capture-end';
type TraceFile =
  'light-start-frame-trace.json' | 'observer-readiness-frame-trace.json';
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

const owned = new WeakMap<TestInfo, Set<FrameTrace>>();

class FrameTrace {
  private worker?: Worker;
  private sessions = new Set<CDPSession>();
  private browserSession?: CDPSession;
  private complete?: Promise<Complete>;
  private targetFrame?: string;
  private otherFrames: (string | undefined)[] = [];
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

  async arm() {
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
          const roots = await Promise.all(
            [this.page, ...this.otherPages].map(async (page) => {
              try {
                const target = await this.session(() =>
                  page.context().newCDPSession(page),
                );
                const tree = await deadline(
                  target.send('Page.getFrameTree'),
                  250,
                );
                return tree.frameTree.frame.id as string;
              } catch {
                return undefined;
              }
            }),
          );
          if (this.closed) return;
          [this.targetFrame, ...this.otherFrames] = roots;
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
    let facts: Record<string, unknown> = { status: 'not-armed' };
    let live = true;
    try {
      if (this.armed && this.browserSession && this.complete) {
        const session = this.browserSession;
        const complete = this.complete;
        facts = await deadline(
          (async () => {
            await session.send('Tracing.end');
            this.endConfirmed = true;
            const terminal = await complete;
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
      targetFrame: this.targetFrame,
      otherFrames: this.otherFrames,
      otherPageCount: this.otherPages.length,
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
