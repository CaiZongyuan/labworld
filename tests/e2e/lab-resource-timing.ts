import type { CDPSession, Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedBrowserFact } from './lab-browser-facts.ts';

type Kind = 'world' | 'hdr' | 'asset-download' | 'object';
type Resource = {
  order: number;
  kind: Kind;
  requestedCdpSeconds?: number;
  requestedNodeMs: number;
  responseCdpSeconds?: number;
  responseNodeMs?: number;
  status?: number;
  finishedCdpSeconds?: number;
  finishedNodeMs?: number;
  encodedBytes?: number;
  failedNodeMs?: number;
  canceled?: boolean;
};
function kindOf(url: string): Kind | undefined {
  try {
    const path = new URL(url).pathname;
    if (/^\/api\/v1\/lab\/labs\/[0-9a-f-]{36}\/world$/i.test(path))
      return 'world';
    if (path === '/lab-assets/hdr/studio.hdr') return 'hdr';
    if (/^\/api\/v1\/lab\/assets\/[0-9a-f-]{36}\/download$/i.test(path))
      return 'asset-download';
    if (/^\/objects\/[0-9a-f-]{36}$/i.test(path)) return 'object';
  } catch {
    // Unknown paths and arbitrary URL arguments are never retained.
  }
}
function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function token(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f-]{16,80}$/i.test(value)
    ? value
    : null;
}

// Optional evidence starts asynchronously and cannot delay the ready assertion.
export function observeResourceTiming(page: Page) {
  let session: CDPSession | undefined;
  let closed = false;
  let omittedRequests = 0;
  let finished: Promise<void> | undefined;
  const requests = new Map<string, Resource>();
  const resources: Resource[] = [];
  const marks: { phase: 'assertion-end'; nodeMs: number }[] = [];
  const documents: {
    phase: 'post-goto' | 'assertion-start';
    startedNodeMs: number;
    fact?: Awaited<ReturnType<typeof captureDocument>>;
  }[] = [];
  const pendingDocuments: Promise<unknown>[] = [];
  const sessionReady = page
    .context()
    .newCDPSession(page)
    .then((owned) => {
      if (closed) {
        void owned.detach().catch(() => {});
        throw new Error('Resource observer closed');
      }
      session = owned;
      owned.on('Network.requestWillBeSent', (event) => {
        if (closed) return;
        const kind = kindOf(event.request.url);
        if (!kind) return;
        if (resources.length >= 64) {
          omittedRequests++;
          return;
        }
        const resource: Resource = {
          order: resources.length,
          kind,
          requestedCdpSeconds: finite(event.timestamp),
          requestedNodeMs: performance.now(),
        };
        requests.set(event.requestId, resource);
        resources.push(resource);
      });
      owned.on('Network.responseReceived', (event) => {
        const resource = requests.get(event.requestId);
        if (closed || !resource) return;
        resource.responseCdpSeconds = finite(event.timestamp);
        resource.responseNodeMs = performance.now();
        if (
          Number.isInteger(event.response.status) &&
          event.response.status >= 100 &&
          event.response.status <= 599
        )
          resource.status = event.response.status;
      });
      owned.on('Network.loadingFinished', (event) => {
        const resource = requests.get(event.requestId);
        if (closed || !resource) return;
        resource.finishedCdpSeconds = finite(event.timestamp);
        resource.finishedNodeMs = performance.now();
        resource.encodedBytes = finite(event.encodedDataLength);
        requests.delete(event.requestId);
      });
      owned.on('Network.loadingFailed', (event) => {
        const resource = requests.get(event.requestId);
        if (closed || !resource) return;
        resource.failedNodeMs = performance.now();
        resource.canceled = event.canceled === true;
        requests.delete(event.requestId);
      });
      return owned;
    });
  const arming = boundedBrowserFact(async () => {
    const owned = await sessionReady;
    await owned.send('Network.enable');
    return { enabled: true };
  });
  function captureDocument() {
    return boundedBrowserFact(async () => {
      const owned = await sessionReady;
      const tree = await owned.send('Page.getFrameTree');
      const frame = tree.frameTree.frame;
      const path = new URL(frame.url).pathname;
      return {
        frame: token(frame.id),
        loader: token(frame.loaderId),
        path: ['/lab', '/register', '/login'].includes(path)
          ? path
          : '<REDACTED>',
        acknowledgedNodeMs: performance.now(),
      };
    });
  }
  async function stop() {
    closed = true;
    const [arm] = await Promise.all([arming, ...pendingDocuments]);
    const detach = session
      ? await boundedBrowserFact(() => session!.detach())
      : null;
    const packet = {
      scope:
        'CDP Network completion is transport evidence, not JSON consumption, decode or rendering; monotonic CDP seconds and Node receipt ms require verified clock correlation',
      arming: arm,
      resources,
      documents,
      marks,
      omittedRequests,
      cleanup: { sessionCaptured: !!session, detach },
      rawUrlsHeadersBodiesAndMessagesSaved: false,
    };
    try {
      if (process.env.LAB_NODE_EVIDENCE)
        writeFileSync(
          join(process.env.LAB_NODE_EVIDENCE, 'observer-resource-timing.json'),
          JSON.stringify(packet) + '\n',
          { mode: 0o600 },
        );
    } catch {
      // Optional evidence cannot replace the original business assertion.
    }
  }
  return {
    capture(phase: 'post-goto' | 'assertion-start') {
      if (closed || documents.length >= 2) return;
      const document: (typeof documents)[number] = {
        phase,
        startedNodeMs: performance.now(),
      };
      documents.push(document);
      pendingDocuments.push(
        captureDocument().then((fact) => {
          document.fact = fact;
        }),
      );
    },
    mark(phase: 'assertion-end') {
      if (!closed) marks.push({ phase, nodeMs: performance.now() });
    },
    finish() {
      finished ??= stop();
      return finished;
    },
  };
}
