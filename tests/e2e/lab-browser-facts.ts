import type { Page } from '@playwright/test';

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
