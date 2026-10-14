import type { Page, Request, Response } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedBrowserFact, observeBrowserFailure } from './lab-browser-facts';
import { historyWorldProjection } from './original-predicate-facts';

type Name = 'history' | 'records' | 'static-render';
type ResponseFact = {
  kind: 'start' | 'world' | 'stream';
  at: number;
  status: number;
  finishedAt: number | null;
  body: 'not-read' | 'pending' | 'ack' | 'error';
  bodyAt?: number;
  programRunning?: boolean;
  runMatchesStart?: boolean | null;
  world?: ReturnType<typeof historyWorldProjection>['facts'];
};
type Observation = {
  name: Name;
  startedAt: number;
  responses: ResponseFact[];
  boundary: ReturnType<typeof observeBrowserFailure>;
  stop: () => void;
};
const observations = new WeakMap<Page, Observation>();

/** Isolated diagnostic: passive network facts, no setup wait or new request. */
export function beginFrontendFrontier(page: Page, name: Name) {
  const responses: ResponseFact[] = [];
  const byRequest = new Map<Request, ResponseFact>();
  let targetId: string | undefined;
  let runId: string | undefined;
  let observing = true;
  const response = (value: Response) => {
    if (!observing || responses.length >= 32) return;
    const path = new URL(value.url()).pathname;
    const start = path.match(/\/entities\/([0-9a-f-]{36})\/program\/start$/i);
    const kind = start
      ? 'start'
      : path.endsWith('/world')
        ? 'world'
        : path.endsWith('/world/subscribe')
          ? 'stream'
          : null;
    if (!kind) return;
    if (start) targetId = start[1];
    const fact: ResponseFact = {
      kind,
      at: performance.now(),
      status: value.status(),
      finishedAt: null,
      body: 'not-read',
    };
    responses.push(fact);
    byRequest.set(value.request(), fact);
    if (kind === 'stream' || !targetId) return;
    fact.body = 'pending';
    // Do not await, race or retry the original response on the assertion path.
    void value.json().then(
      (body) => {
        if (!observing) return;
        fact.body = 'ack';
        fact.bodyAt = performance.now();
        if (kind === 'start') {
          runId = typeof body?.id === 'string' ? body.id : undefined;
          fact.programRunning = body?.status === 'running';
        } else {
          const projected = historyWorldProjection(body, targetId!);
          fact.world = projected.facts;
          fact.runMatchesStart =
            runId && projected.identity.run
              ? runId === projected.identity.run
              : null;
        }
      },
      () => {
        if (!observing) return;
        fact.body = 'error';
        fact.bodyAt = performance.now();
      },
    );
  };
  const finished = (request: Request) => {
    const fact = byRequest.get(request);
    if (fact) fact.finishedAt = performance.now();
  };
  const observation: Observation = {
    name,
    startedAt: performance.now(),
    responses,
    boundary: observeBrowserFailure(page),
    stop: () => {
      observing = false;
      page.off('response', response);
      page.off('requestfinished', finished);
    },
  };
  observations.set(page, observation);
  page.on('response', response);
  page.on('requestfinished', finished);
}

/** Failure-only browser/target reads; the original verdict is never replaced. */
export async function endFrontendFrontier(
  page: Page,
  status: string | undefined,
  expectedStatus: string,
) {
  const observed = observations.get(page);
  if (!observed) return;
  const afterEachAt = performance.now();
  let failureFacts: unknown = null;
  try {
    if (status !== expectedStatus) {
      const [boundary, dom] = await Promise.all([
        observed.boundary(),
        boundedBrowserFact(() =>
          page.evaluate(() => {
            const root = document.querySelector('.world-page');
            const panel = root?.querySelector('.device-panel');
            const buttons = Array.from(panel?.querySelectorAll('button') ?? []);
            const start = buttons.find(
              (button) => button.textContent?.trim() === '开始离心',
            );
            const program = buttons.find((button) =>
              ['启动程序', '停止程序'].includes(
                button.textContent?.trim() ?? '',
              ),
            );
            const states: Record<string, string> = {
              程序未启动: 'not-started',
              运行中: 'running',
              已停止: 'stopped',
              实时同步: 'live',
              正在连接: 'connecting',
              连接中断: 'offline',
              正在请求来源变更: 'submitting',
              '来源已启动，等待此 Run 的新观测。': 'succeeded',
            };
            const state = (element: Element | null | undefined) =>
              states[element?.textContent?.trim() ?? ''] ??
              (element ? 'unknown' : null);
            return {
              documentEpoch: performance.timeOrigin,
              browserAt: performance.now(),
              rootPresent: !!root,
              busy: root?.getAttribute('aria-busy') ?? null,
              canvasCount: root?.querySelectorAll('canvas').length ?? 0,
              lazyLoading: !!root?.querySelector('.lab-loading'),
              renderError: !!root?.querySelector('.world-render-error'),
              performancePanel: !!root?.querySelector('.lab-perf'),
              startPresent: !!start,
              startDisabled: start?.disabled ?? null,
              programDisabled: program?.disabled ?? null,
              programStatus: state(
                panel?.querySelector(
                  '.lab-section-heading [data-slot="badge"]',
                ),
              ),
              sourcePhase: state(panel?.querySelector('p[role="status"]')),
              connection: state(
                root?.querySelector('.lab-heading [aria-live]'),
              ),
            };
          }),
        ),
      ]);
      failureFacts = { boundary, dom };
    }
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        `frontend-${observed.name}-facts.json`,
      ),
      JSON.stringify({
        name: observed.name,
        startedAt: observed.startedAt,
        afterEachAt,
        status,
        expectedStatus,
        scope:
          'Passive response/body observations; failure-only 250ms reads. No app-state or CPU inference.',
        responses: observed.responses,
        responseCapacityReached: observed.responses.length === 32,
        failureFacts,
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // A missing diagnostic remains unknown; preserve original test outcome.
  } finally {
    observed.stop();
    observations.delete(page);
  }
}
