import type { CDPSession, Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** DEBUG-model-acquisition: evidence only; no request/response/header payload is retained. */
export class ModelAcquisitionOwnerObserver {
  private sessions: CDPSession[] = [];
  private events = 0;
  private closed = false;
  private documents = new Map<string, number>();
  private documentSequence = 0;
  private requests = new Map<
    string,
    { page: number; kind: string; document: number; request: number }
  >();
  private requestSequence = 0;
  private record(value: object) {
    if (this.closed || this.events++ > 1600) return;
    appendFileSync(
      join(process.env.LAB_NODE_EVIDENCE!, 'model-acquisition-owners.jsonl'),
      JSON.stringify({ at: performance.now(), ...value }) + '\n',
      { mode: 0o600 },
    );
  }
  private document(value: string) {
    let id = this.documents.get(value);
    if (!id) this.documents.set(value, (id = ++this.documentSequence));
    return id;
  }
  readonly bind = async (page: Page, index: number) => {
    const session = await page.context().newCDPSession(page);
    this.sessions.push(session);
    page.on('console', (message) => {
      const prefix = 'DEBUG-model-acquisition ';
      if (!message.text().startsWith(prefix)) return;
      const fact = JSON.parse(message.text().slice(prefix.length)) as Record<
        string,
        unknown
      >;
      const allowed = new Set([
        'event',
        'documentEpoch',
        'at',
        'attempt',
        'authority',
        'client',
        'resource',
        'owner',
        'consumers',
        'aborted',
        'success',
        'status',
        'meshes',
        'model',
        'triangles',
        'parent',
        'scene',
        'metadataMatch',
      ]);
      const names = new Set([
        'canvas-created',
        'load-start',
        'load-cleanup',
        'model-ready',
        'scene-attached',
        'capability-start',
        'capability-ready',
        'bytes-start',
        'bytes-response',
        'attempt-settled',
        'lease-acquired',
        'lease-released',
      ]);
      if (Object.keys(fact).some((key) => !allowed.has(key))) return;
      if (
        !names.has(String(fact.event)) ||
        Object.entries(fact).some(
          ([key, value]) =>
            key !== 'event' &&
            typeof value !== 'boolean' &&
            !(typeof value === 'number' && Number.isFinite(value)),
        )
      )
        return;
      this.record({ event: 'renderer-fact', page: index, fact });
    });
    session.on('Network.requestWillBeSent', (event) => {
      const path = new URL(event.request.url).pathname;
      const kind =
        path === '/lab' && event.type === 'Document'
          ? 'document'
          : /^\/api\/v1\/lab\/assets\/[0-9a-f-]{36}\/download$/.test(path)
            ? 'authorization'
            : /^\/objects\/[0-9a-f-]{36}$/.test(path) &&
                event.request.method === 'GET'
              ? 'bytes'
              : null;
      if (!kind) return;
      const key = `${index}:${event.requestId}`;
      const request = {
        page: index,
        kind,
        document: this.document(`${index}:${event.loaderId}`),
        request: ++this.requestSequence,
      };
      this.requests.set(key, request);
      this.record({ event: 'request-start', ...request });
    });
    session.on('Network.responseReceived', (event) => {
      const request = this.requests.get(`${index}:${event.requestId}`);
      if (request)
        this.record({
          event: 'response',
          ...request,
          status: event.response.status,
        });
    });
    session.on('Network.loadingFailed', (event) => {
      const key = `${index}:${event.requestId}`;
      const request = this.requests.get(key);
      if (request)
        this.record({
          event: 'request-failed',
          ...request,
          canceled: event.canceled === true,
        });
      this.requests.delete(key);
    });
    session.on('Network.loadingFinished', (event) => {
      const key = `${index}:${event.requestId}`;
      const request = this.requests.get(key);
      if (request) this.record({ event: 'request-finished', ...request });
      this.requests.delete(key);
    });
    session.on('Page.frameNavigated', (event) => {
      if (event.frame.parentId) return;
      this.record({
        event: 'document-committed',
        page: index,
        document: this.document(`${index}:${event.frame.loaderId}`),
      });
    });
    await session.send('Network.enable');
    await session.send('Page.enable');
  };
  phase(page: number, phase: string) {
    this.record({ event: 'phase', page, phase });
  }
  async close() {
    for (const session of this.sessions) await session.detach().catch(() => {});
    this.record({ event: 'observer-closed', sessions: this.sessions.length });
    this.closed = true;
  }
}
