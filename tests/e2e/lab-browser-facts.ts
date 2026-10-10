import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const knownErrorNames = new Set([
  'Error',
  'TypeError',
  'ReferenceError',
  'RangeError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'RuntimeError',
  'CompileError',
  'LinkError',
  'TimeoutError',
  'TargetClosedError',
]);

function errorName(error: Error) {
  return knownErrorNames.has(error.name) ? error.name : 'OtherError';
}

type Capture<T> =
  | { status: 'ack'; elapsedMs: number; value: T }
  | { status: 'error'; elapsedMs: number; errorName: string }
  | { status: 'timeout'; elapsedMs: number };

export async function boundedBrowserFact<T>(
  capture: () => Promise<T>,
): Promise<Capture<T>> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(capture)
        .then(
          (value): Capture<T> => ({
            status: 'ack',
            elapsedMs: performance.now() - started,
            value,
          }),
          (error: unknown): Capture<T> => ({
            status: 'error',
            elapsedMs: performance.now() - started,
            errorName: error instanceof Error ? errorName(error) : 'OtherError',
          }),
        ),
      new Promise<Capture<T>>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: 'timeout',
              elapsedMs: performance.now() - started,
            }),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function observeBrowserFailure(page: Page) {
  const pageErrors: Record<string, number> = {};
  let crashes = 0;
  let closes = 0;
  let mainFrameNavigations = 0;
  page.on('pageerror', (error) => {
    const name = errorName(error);
    pageErrors[name] = (pageErrors[name] ?? 0) + 1;
  });
  page.on('crash', () => crashes++);
  page.on('close', () => closes++);
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations++;
  });

  return async () => {
    const [frame, browser] = await Promise.all([
      boundedBrowserFact(() =>
        page.mainFrame().evaluate(() => ({
          ack: true,
          bodyPresent: !!document.body,
          readyState: document.readyState,
        })),
      ),
      boundedBrowserFact(async () => {
        const browser = page.context().browser();
        if (!browser) throw new Error('Browser control unavailable');
        const session = await browser.newBrowserCDPSession();
        try {
          await session.send('Browser.getVersion');
          return { ack: true };
        } finally {
          void session.detach().catch(() => {});
        }
      }),
    ]);
    return {
      frame,
      browser,
      events: {
        pageErrors: { ...pageErrors },
        crashes,
        closes,
        mainFrameNavigations,
        pageClosed: page.isClosed(),
      },
    };
  };
}

/** Failure-only facts at an owning action; caller keeps the original error. */
export function observeBrowserSeam(
  page: Page,
  seam: string,
  runtimeFacts = false,
) {
  const boundary = observeBrowserFailure(page);
  const responses: { path: string; status: number }[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (
      responses.length < 40 &&
      (path.endsWith('/world') ||
        path === '/api/v1/lab/labs' ||
        path.startsWith('/api/v1/lab/assets') ||
        path.startsWith('/objects/'))
    )
      responses.push({ path, status: response.status() });
  });
  return async () => {
    const [browser, dom] = await Promise.all([
      boundary(),
      boundedBrowserFact(() =>
        page.mainFrame().evaluate(() => {
          const root = document.querySelector('.world-page, .lab-page');
          const inspector = root?.querySelector('.world-inspector');
          const tabs = Array.from(
            inspector?.querySelectorAll('[role="tab"]') ?? [],
          );
          const selectedLab = (
            root?.querySelector(
              'select[aria-label="打开 Lab"],select[aria-label="Open Lab"]',
            ) as HTMLSelectElement | null
          )?.value;
          return {
            rootPresent: !!root,
            rootKind: root?.classList.contains('world-page')
              ? 'world'
              : root
                ? 'asset-viewer'
                : null,
            busy: root?.getAttribute('aria-busy') ?? null,
            selectedLab: /^[0-9a-f-]{36}$/i.test(selectedLab ?? '')
              ? selectedLab
              : null,
            canvasCount: root?.querySelectorAll('canvas').length ?? 0,
            loadingCount: root?.querySelectorAll('.lab-loading').length ?? 0,
            renderErrorCount:
              root?.querySelectorAll('.world-render-error').length ?? 0,
            inspectorPresent: !!inspector,
            inspectorHidden: inspector?.hasAttribute('hidden') ?? null,
            inspectorHasRectangle: inspector
              ? inspector.getClientRects().length > 0
              : null,
            tabs: tabs.map((tab) => ({
              label: /^(详情|操作|记录|Details|Operations|Records)$/.test(
                tab.textContent?.trim() ?? '',
              )
                ? tab.textContent?.trim()
                : null,
              selected: tab.getAttribute('aria-selected'),
              connected: tab.isConnected,
              hasRectangle: tab.getClientRects().length > 0,
            })),
          };
        }),
      ),
    ]);
    const capturedAt = new Date().toISOString();
    const runtime = runtimeFacts
      ? await Promise.all([
          boundedBrowserFact(async () => {
            const browser = page.context().browser();
            if (!browser) throw new Error('Browser control unavailable');
            const session = await browser.newBrowserCDPSession();
            try {
              const { processInfo } = await session.send(
                'SystemInfo.getProcessInfo',
              );
              return processInfo.map(({ id, type, cpuTime }) => ({
                id,
                type,
                cpuTime,
              }));
            } finally {
              void session.detach().catch(() => {});
            }
          }),
          boundedBrowserFact(async () => {
            const session = await page.context().newCDPSession(page);
            try {
              await session.send('Performance.enable');
              const { metrics } = await session.send('Performance.getMetrics');
              const names = new Set([
                'TaskDuration',
                'ScriptDuration',
                'LayoutDuration',
                'RecalcStyleDuration',
                'JSHeapUsedSize',
                'Nodes',
                'Frames',
              ]);
              return metrics.filter(({ name }) => names.has(name));
            } finally {
              void session.detach().catch(() => {});
            }
          }),
          boundedBrowserFact(async () => {
            // This owning surface contains no credential form; other callers get no screenshot.
            if (new URL(page.url()).pathname !== '/lab/asset')
              return { status: 'not-captured' };
            const file = `${seam}-failure.png`;
            await page.screenshot({
              path: join(process.env.LAB_NODE_EVIDENCE ?? 'test-results', file),
              animations: 'disabled',
              timeout: 250,
            });
            return { file };
          }),
        ])
      : null;
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        `${seam}-failure.json`,
      ),
      JSON.stringify(
        {
          seam,
          capturedAt,
          path: new URL(page.url()).pathname,
          browser,
          dom,
          responses,
          ...(runtime
            ? {
                processes: runtime[0],
                taskMetrics: runtime[1],
                screenshot: runtime[2],
                metricsScope:
                  'fresh single cumulative sample; timeout/error leaves cause unknown',
              }
            : {}),
        },
        null,
        2,
      ),
    );
  };
}
