import type { Page, Request, Response, ConsoleMessage } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedBrowserFact, observeBrowserFailure } from './lab-browser-facts';

const stages = new Set([
  'canvas-created',
  'renderer-labelled',
  'load-start',
  'load-cleanup',
  'model-ready',
  'capability-start',
  'capability-ready',
  'bytes-start',
  'bytes-response',
  'bytes-ready',
  'attempt-settled',
  'lease-acquired',
  'lease-released',
  'parse-start',
  'parse-complete',
  'load-error',
  'imported-ready',
  'node-measure',
  'ready-callback',
  'current-appearance',
]);
const fields = new Set([
  'documentEpoch',
  'at',
  'attempt',
  'owner',
  'authority',
  'client',
  'resource',
  'consumers',
  'success',
  'metadataMatch',
  'status',
  'bytes',
  'sizeMatch',
  'load',
  'model',
  'meshes',
  'aborted',
  'abortError',
  'modelImportError',
  'callback',
  'node',
  'key',
  'viewport',
  'groupPresent',
  'currentKey',
  'currentResource',
  'currentOwner',
  'currentAuthority',
  'currentClient',
  'readyKey',
  'readyOwner',
  'readyAuthority',
  'readyClient',
  'failedKey',
  'failedOwner',
  'failedAuthority',
  'failedClient',
  'readyMatchesCurrent',
  'failedMatchesCurrent',
  'pending',
]);
type RequestFact = {
  kind: string;
  ordinal: number;
  at: number;
  status: number | null;
  finishedAt: number | null;
  failedAt: number | null;
};
type Observation = {
  requests: RequestFact[];
  lifecycle: Record<string, unknown>[];
  boundary: ReturnType<typeof observeBrowserFailure>;
  stop: () => void;
};
const observations = new WeakMap<Page, Observation>();
const kind = (request: Request) => {
  const path = new URL(request.url()).pathname;
  if (path.endsWith('/download')) return 'asset-authorization';
  if (path.startsWith('/objects/') && request.method() === 'GET')
    return 'object-read';
  if (path.includes('/lab-assets/decoders/draco/'))
    return path.endsWith('.wasm') ? 'draco-wasm' : 'draco-script';
  if (path.includes('/lab-assets/decoders/basis/'))
    return path.endsWith('.wasm') ? 'basis-wasm' : 'basis-script';
  if (path.includes('/lab-assets/hdr/')) return 'environment-hdr';
  if (path.endsWith('/world')) return 'world';
  return null;
};

/** Passive actual events only; no request, wait or original-case mutation. */
export function beginStaticModelFacts(page: Page) {
  const requests: RequestFact[] = [],
    lifecycle: Record<string, unknown>[] = [];
  const byRequest = new Map<Request, RequestFact>();
  let ordinal = 0;
  const started = (request: Request) => {
    const route = kind(request);
    if (!route || requests.length >= 64) return;
    const fact = {
      kind: route,
      ordinal: ++ordinal,
      at: performance.now(),
      status: null,
      finishedAt: null,
      failedAt: null,
    };
    requests.push(fact);
    byRequest.set(request, fact);
  };
  const response = (value: Response) => {
    const fact = byRequest.get(value.request());
    if (fact) fact.status = value.status();
  };
  const finished = (request: Request) => {
    const fact = byRequest.get(request);
    if (fact) fact.finishedAt = performance.now();
  };
  const failed = (request: Request) => {
    const fact = byRequest.get(request);
    if (fact) fact.failedAt = performance.now();
  };
  const console = (message: ConsoleMessage) => {
    const text = message.text();
    if (!text.startsWith('DEBUG-static-pending ') || lifecycle.length >= 256)
      return;
    try {
      const value = JSON.parse(text.slice('DEBUG-static-pending '.length));
      if (!stages.has(value.event)) return;
      const projected: Record<string, unknown> = {
        event: value.event,
        receivedAt: performance.now(),
      };
      for (const [key, field] of Object.entries(value))
        if (
          fields.has(key) &&
          (typeof field === 'boolean' ||
            (typeof field === 'number' && Number.isFinite(field)))
        )
          projected[key] = field;
      lifecycle.push(projected);
    } catch {
      /* Retain the original verdict on diagnostic decode failure. */
    }
  };
  const observation = {
    requests,
    lifecycle,
    boundary: observeBrowserFailure(page),
    stop: () => {
      page.off('request', started);
      page.off('response', response);
      page.off('requestfinished', finished);
      page.off('requestfailed', failed);
      page.off('console', console);
    },
  };
  observations.set(page, observation);
  page.on('request', started);
  page.on('response', response);
  page.on('requestfinished', finished);
  page.on('requestfailed', failed);
  page.on('console', console);
}

export async function endStaticModelFacts(
  page: Page,
  status: string | undefined,
) {
  const observation = observations.get(page);
  if (!observation) return;
  const afterEachAt = performance.now();
  try {
    const [boundary, dom] = await Promise.all([
      observation.boundary(),
      boundedBrowserFact(() =>
        page.evaluate(() => {
          const root = document.querySelector('.world-page');
          const canvas = root?.querySelector<HTMLCanvasElement>(
            'canvas[aria-label="三维视口"]',
          );
          const rectangle = canvas?.getBoundingClientRect();
          return {
            documentEpoch: performance.timeOrigin,
            browserAt: performance.now(),
            rootPresent: !!root,
            busy: root?.getAttribute('aria-busy') ?? null,
            labelledCanvasVisible:
              !!rectangle && rectangle.width > 0 && rectangle.height > 0,
            renderError: !!root?.querySelector('.world-render-error'),
            lazyLoading: !!root?.querySelector('.lab-loading'),
            performancePanel: !!root?.querySelector('.lab-perf'),
          };
        }),
      ),
    ]);
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        'static-model-pending-facts.json',
      ),
      JSON.stringify(
        {
          scope:
            'Original c7 static model chain; numeric opaque identities, no credential/resource values; afterEach is not assertion time',
          afterEachAt,
          status,
          requests: observation.requests,
          lifecycle: observation.lifecycle,
          boundary,
          dom,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* Diagnostic failure cannot replace the original case error. */
  } finally {
    observation.stop();
    observations.delete(page);
  }
}
