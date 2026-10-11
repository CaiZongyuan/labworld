import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page, WebSocket as BrowserSocket } from '@playwright/test';

type Predicate = {
  outcome: 'passed' | 'failed';
  expectedGreaterThan: number;
  actual: number;
  budgetMs: 5000;
};
type Socket = {
  requestId: string;
  session: string;
  keySha256: string | null;
  createdObservedEpochMs: number;
  protocolEpochOffsetMs?: number;
  closedProtocolEpochMs?: number;
  closedObservedEpochMs?: number;
  receivedFrames: number;
  receivedFramesAtAction?: number;
  lastReceivedProtocolEpochMs?: number;
  lastReceivedObservedEpochMs?: number;
};
const epochNow = () => performance.timeOrigin + performance.now();
const viewerSession = (url: string) => {
  try {
    return new URL(url).pathname.match(
      /^\/api\/v1\/lab\/motion\/sessions\/([0-9a-f-]{36})\/viewer$/,
    )?.[1];
  } catch {
    return undefined;
  }
};

/** Diagnostic branch only: observe the original case without controlling it. */
export async function offlineCloseProbe(page: Page, output: string) {
  const cdp = await page.context().newCDPSession(page);
  const sockets = new Map<string, Socket>();
  const playwright: {
    session: string;
    createdEpochMs: number;
    closedEpochMs?: number;
  }[] = [];
  const ownedSocketListeners: { socket: BrowserSocket; close: () => void }[] =
    [];
  let overflow = false;
  let session: string | undefined;
  let actionEpochMs: number | undefined;
  let predicateStartedEpochMs: number | undefined;
  const created = (event: { requestId: string; url: string }) => {
    const id = viewerSession(event.url);
    if (!id) return;
    if (sockets.size >= 32) {
      overflow = true;
      return;
    }
    sockets.set(event.requestId, {
      requestId: event.requestId,
      session: id,
      keySha256: null,
      createdObservedEpochMs: epochNow(),
      receivedFrames: 0,
    });
  };
  const handshake = (event: {
    requestId: string;
    timestamp: number;
    wallTime: number;
    request: { headers: Record<string, string> };
  }) => {
    const row = sockets.get(event.requestId);
    if (!row) return;
    row.protocolEpochOffsetMs = (event.wallTime - event.timestamp) * 1000;
    const key = Object.entries(event.request.headers).find(
      ([name]) => name.toLowerCase() === 'sec-websocket-key',
    )?.[1];
    if (typeof key === 'string' && key.length <= 64)
      row.keySha256 = createHash('sha256').update(key).digest('hex');
  };
  const closed = (event: { requestId: string; timestamp: number }) => {
    const row = sockets.get(event.requestId);
    if (!row) return;
    row.closedObservedEpochMs = epochNow();
    if (row.protocolEpochOffsetMs !== undefined)
      row.closedProtocolEpochMs =
        event.timestamp * 1000 + row.protocolEpochOffsetMs;
  };
  const received = (event: { requestId: string; timestamp: number }) => {
    const row = sockets.get(event.requestId);
    if (row) {
      row.receivedFrames++;
      row.lastReceivedObservedEpochMs = epochNow();
      if (row.protocolEpochOffsetMs !== undefined)
        row.lastReceivedProtocolEpochMs =
          event.timestamp * 1000 + row.protocolEpochOffsetMs;
    }
  };
  const browserSocket = (socket: BrowserSocket) => {
    const id = viewerSession(socket.url());
    if (!id) return;
    if (playwright.length >= 32) {
      overflow = true;
      return;
    }
    const row = {
      session: id,
      createdEpochMs: epochNow(),
    } as (typeof playwright)[number];
    playwright.push(row);
    const close = () => {
      row.closedEpochMs = epochNow();
    };
    socket.on('close', close);
    ownedSocketListeners.push({ socket, close });
  };
  cdp.on('Network.webSocketCreated', created);
  cdp.on('Network.webSocketWillSendHandshakeRequest', handshake);
  cdp.on('Network.webSocketClosed', closed);
  cdp.on('Network.webSocketFrameReceived', received);
  page.on('websocket', browserSocket);
  try {
    await cdp.send('Network.enable');
  } catch {
    await dispose();
    throw new Error('Offline diagnostic network observer unavailable');
  }

  function writeReport(path: string, report: Record<string, unknown>) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
      });
    } catch {
      // Keep the original predicate/teardown intact when diagnostic storage fails.
      console.log(
        JSON.stringify({
          diagnostic: 'offline-close-probe',
          persistence: 'failed',
          originalPredicate: report.originalPredicate,
          cleanupReceipt:
            report.cdpDetached === undefined ? undefined : 'unwritten',
        }),
      );
    }
  }

  async function begin(id: string) {
    session = id;
    await page.evaluate((id) => {
      const target = window as typeof window & {
        __labOfflineProbe?: {
          snapshot: () => unknown;
          restore: () => {
            closeDescriptorRestored: boolean;
            listenersRemoved: boolean;
          };
        };
      };
      const rows: Record<string, unknown>[] = [];
      const tracked = new Map<WebSocket, { calls: number }>();
      const closeListeners: { socket: WebSocket; close: () => void }[] = [];
      let overflow = false,
        observerError = false;
      const stamp = () => performance.timeOrigin + performance.now();
      const reception = () =>
        document
          .querySelector('[aria-label="运动接收"]')
          ?.textContent?.trim()
          .slice(0, 120) ?? null;
      function record(event: string, data: Record<string, unknown> = {}) {
        if (rows.length >= 128) {
          overflow = true;
          return;
        }
        rows.push({
          event,
          epochMs: stamp(),
          navigatorOnline: navigator.onLine,
          reception: reception(),
          ...data,
        });
      }
      const network = (event: Event) => record(event.type);
      window.addEventListener('offline', network, true);
      window.addEventListener('online', network, true);
      const status = document.querySelector('[aria-label="运动接收"]');
      const mutation = new MutationObserver(() => record('reception-mutation'));
      if (status)
        mutation.observe(status, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      const descriptor = Object.getOwnPropertyDescriptor(
        WebSocket.prototype,
        'close',
      )!;
      const originalClose = descriptor.value as WebSocket['close'];
      const close = function (
        this: WebSocket,
        ...args: Parameters<WebSocket['close']>
      ) {
        let watched = false;
        try {
          watched =
            new URL(this.url).pathname ===
            `/api/v1/lab/motion/sessions/${id}/viewer`;
          if (watched) {
            let row = tracked.get(this);
            if (!row && tracked.size < 8) {
              row = { calls: 0 };
              tracked.set(this, row);
              const listener = () =>
                record('native-close-event', { readyState: this.readyState });
              this.addEventListener('close', listener, { once: true });
              closeListeners.push({ socket: this, close: listener });
            } else if (!row) overflow = true;
            if (row) {
              row.calls++;
            }
            record('native-close-call', {
              readyState: this.readyState,
              argumentCount: args.length,
            });
          }
        } catch {
          observerError = true;
        }
        try {
          const result = Reflect.apply(originalClose, this, args);
          try {
            if (watched)
              record('native-close-return', { readyState: this.readyState });
          } catch {
            observerError = true;
          }
          return result;
        } catch (error) {
          try {
            if (watched) record('native-close-throw');
          } catch {
            observerError = true;
          }
          throw error;
        }
      };
      Object.defineProperty(WebSocket.prototype, 'close', {
        ...descriptor,
        value: close,
      });
      target.__labOfflineProbe = {
        snapshot: () => ({
          clock: 'browser performance.timeOrigin + performance.now',
          sampledEpochMs: stamp(),
          navigatorOnline: navigator.onLine,
          reception: reception(),
          rows: rows.slice(),
          overflow,
          observerError,
          sockets: [...tracked].map(([socket, row]) => ({
            readyState: socket.readyState,
            closeCalls: row.calls,
          })),
        }),
        restore: () => {
          Object.defineProperty(WebSocket.prototype, 'close', descriptor);
          window.removeEventListener('offline', network, true);
          window.removeEventListener('online', network, true);
          mutation.disconnect();
          for (const { socket, close } of closeListeners)
            socket.removeEventListener('close', close);
          tracked.clear();
          closeListeners.length = 0;
          delete target.__labOfflineProbe;
          return {
            closeDescriptorRestored: (
              Object.keys(descriptor) as (keyof PropertyDescriptor)[]
            ).every(
              (key) =>
                Object.getOwnPropertyDescriptor(WebSocket.prototype, 'close')?.[
                  key
                ] === descriptor[key],
            ),
            listenersRemoved: true,
          };
        },
      };
      record('before-offline');
    }, id);
    actionEpochMs = epochNow();
    for (const row of sockets.values())
      if (row.session === session)
        row.receivedFramesAtAction = row.receivedFrames;
  }

  async function capture(predicate: Predicate) {
    const capturedEpochMs = epochNow();
    const dom = await page
      .evaluate(() =>
        (
          window as typeof window & {
            __labOfflineProbe?: { snapshot: () => unknown };
          }
        ).__labOfflineProbe?.snapshot(),
      )
      .catch(() => ({ observerError: 'dom_snapshot_unavailable' }));
    const browser = [...sockets.values()].filter(
      (row) => row.session === session,
    );
    const active = browser.filter(
      (row) =>
        row.createdObservedEpochMs <= (actionEpochMs ?? 0) &&
        (row.closedObservedEpochMs === undefined ||
          row.closedObservedEpochMs >= (actionEpochMs ?? 0)),
    );
    const server: Record<string, unknown>[] = [];
    let serverReadError = false;
    let serverPersistenceInvalid = false;
    try {
      const directory = process.env.MOTION_E2E_OBSERVER_DIR!;
      for (const file of readdirSync(directory).filter((name) =>
        name.endsWith('.json'),
      )) {
        const facts = JSON.parse(
          readFileSync(join(directory, file), 'utf8'),
        ) as {
          pid: number;
          clockTimeOriginMs: number;
          at: string;
          observerPersistence?: { valid: boolean; category: string | null };
          sockets: {
            id: number;
            role: string;
            admitted: boolean;
            scopeId: string;
            handshakeKeySha256?: string;
            open: boolean;
            encrypted: boolean;
            closedAt: number | null;
            closeRequestedAt: number | null;
            remotePort: number;
          }[];
        };
        if (facts.observerPersistence?.valid !== true)
          serverPersistenceInvalid = true;
        for (const row of facts.sockets)
          if (
            row.role === 'viewer' &&
            row.scopeId === session &&
            row.admitted &&
            active.some(
              (browser) =>
                browser.keySha256 &&
                browser.keySha256 === row.handshakeKeySha256,
            )
          )
            server.push({
              pid: facts.pid,
              id: row.id,
              keySha256: row.handshakeKeySha256,
              open: row.open,
              encrypted: row.encrypted,
              remotePort: row.remotePort,
              clock: 'server performance.timeOrigin + performance.now',
              observerWrittenAt: facts.at,
              observerPersistence: facts.observerPersistence,
              closedEpochMs:
                row.closedAt === null
                  ? null
                  : facts.clockTimeOriginMs + row.closedAt,
              closeRequestedEpochMs:
                row.closeRequestedAt === null
                  ? null
                  : facts.clockTimeOriginMs + row.closeRequestedAt,
            });
      }
    } catch {
      serverReadError = true;
    }
    const report = {
      boundary:
        'passive original-case diagnostic; no network/close/event substitution; no acceptance claim',
      clock: 'runner performance.timeOrigin + performance.now',
      actionEpochMs,
      predicateStartedEpochMs,
      capturedEpochMs,
      originalPredicate: predicate,
      beforeNetworkRestoreAndTeardown: true,
      dom,
      browser,
      playwright: playwright.filter((row) => row.session === session),
      server,
      correlationValid:
        !overflow &&
        !serverReadError &&
        !serverPersistenceInvalid &&
        active.length === 1 &&
        !!active[0]?.keySha256 &&
        server.length === 1 &&
        server[0].encrypted === true,
      observerOverflow: overflow,
      serverReadError,
      serverPersistenceInvalid,
      diagnosticEvidenceValidity: 'pending_owned_server_log_readback',
      requiredFinalServerMarker: 'motion.observer_persistence_final',
      invalidServerMarker: 'motion.observer_write_failed',
    };
    writeReport(output, report);
  }

  async function dispose() {
    const domCleanup = await page
      .evaluate(() =>
        (
          window as typeof window & {
            __labOfflineProbe?: { restore: () => unknown };
          }
        ).__labOfflineProbe?.restore(),
      )
      .catch(() => ({ observerError: 'dom_cleanup_unavailable' }));
    page.off('websocket', browserSocket);
    for (const { socket, close } of ownedSocketListeners)
      socket.off('close', close);
    cdp.off('Network.webSocketCreated', created);
    cdp.off('Network.webSocketWillSendHandshakeRequest', handshake);
    cdp.off('Network.webSocketClosed', closed);
    cdp.off('Network.webSocketFrameReceived', received);
    let cdpDetached = false;
    try {
      await cdp.detach();
      cdpDetached = true;
    } catch {
      /* Receipt keeps the failed detach visible. */
    }
    if (session) {
      writeReport(output + '.cleanup.json', {
        domCleanup,
        cdpDetached,
        ownPlaywrightListenersRemoved: true,
      });
    }
  }
  return {
    begin,
    startPredicate() {
      predicateStartedEpochMs = epochNow();
    },
    capture,
    dispose,
  };
}
