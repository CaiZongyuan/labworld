import type { Page, Request } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedBrowserFact, observeBrowserFailure } from './lab-browser-facts';

// Diagnostic branch only. All reads use network, DOM and scoped browser storage.
export function beginPeerSaveObservation() {
  const started = Date.now();
  const events: unknown[] = [];
  const markers: unknown[] = [];
  const transitions: unknown[] = [];
  let latestDom: unknown = null;
  let heartbeat: unknown = null;
  let heartbeatCount = 0;
  let terminal: unknown = null;
  const directory = process.env.LAB_NODE_EVIDENCE!;
  const row = (kind: string, facts: unknown) => ({
    kind,
    nodeTime: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    facts,
  });
  const flush = () =>
    writeFileSync(
      join(directory, 'layout-peer-observation.json'),
      JSON.stringify(
        {
          productHead: 'eba538f9cc3e17033b63b66c04c672b8eeea498f',
          diagnosticHead: process.env.GITHUB_SHA ?? null,
          environment: {
            node: process.version,
            referenceLoad: process.env.E2E_LAB_REFERENCE_LOAD ?? null,
            desktopMigration: process.env.LAB_WORD_MIGRATION_DESKTOP ?? null,
          },
          started,
          deadlineMs: 120000,
          events,
          markers,
          transitions,
          latestDom,
        },
        null,
        2,
      ),
    );
  const record = (kind: string, facts: unknown = {}) => {
    if (events.length < 120) events.push(row(kind, facts));
    flush();
  };
  const mark = (kind: string, facts: unknown = {}) => {
    markers.push(row(kind, facts));
    flush();
  };
  const dom = (value: Record<string, unknown>) => {
    latestDom = row('dom', value);
    if (transitions.length < 80) transitions.push(latestDom);
    flush();
  };
  const beat = (value: unknown) => {
    heartbeat = row('heartbeat', value);
    heartbeatCount++;
    writeFileSync(
      join(directory, 'layout-peer-heartbeat.json'),
      JSON.stringify({ heartbeatCount, heartbeat }, null, 2),
    );
  };
  const finish = (value: unknown) => {
    terminal = row('terminal', value);
    writeFileSync(
      join(directory, 'layout-peer-terminal.json'),
      JSON.stringify(
        { terminal, latestDom, heartbeatCount, heartbeat },
        null,
        2,
      ),
    );
  };
  mark('case-start');
  return { started, record, mark, dom, beat, finish };
}

export async function observePeerSave(
  page: Page,
  lab: string,
  benchId: string,
  observation: ReturnType<typeof beginPeerSaveObservation>,
) {
  const { record, mark } = observation;
  const browserBoundary = observeBrowserFailure(page);
  const requests = new WeakMap<Request, number>();
  const matches = (url: string) => {
    const path = new URL(url).pathname;
    return (
      path === `/api/v1/lab/labs/${lab}/layout` ||
      path === `/api/v1/lab/labs/${lab}/world` ||
      path === '/api/v1/lab/labs'
    );
  };
  page.on('request', (request) => {
    if (!matches(request.url())) return;
    requests.set(request, Date.now());
    const input = request.method() === 'PUT' ? request.postDataJSON() : null;
    record('request', {
      method: request.method(),
      path: new URL(request.url()).pathname,
      expectedVersion: input?.expected_version ?? null,
      selectedPlacement:
        input?.nodes?.find(
          (node: { entity_id: string }) => node.entity_id === benchId,
        )?.placement ?? null,
    });
  });
  page.on('requestfailed', (request) => {
    if (!matches(request.url())) return;
    const failure = request.failure()?.errorText;
    record('request-failed', {
      method: request.method(),
      path: new URL(request.url()).pathname,
      failure: /^net::[A-Z_]+$/.test(failure ?? '') ? failure : 'OtherFailure',
    });
  });
  page.on('response', async (response) => {
    if (!matches(response.url())) return;
    const request = response.request();
    const facts = {
      method: request.method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
      requestElapsedMs: Date.now() - (requests.get(request) ?? Date.now()),
    };
    record('response-headers', facts);
    void response.finished().then(
      (error) =>
        record('response-finished', {
          ...facts,
          outcome: error ? 'error' : 'complete',
          errorName: error?.name ?? null,
        }),
      (error: Error) =>
        record('response-finished', {
          ...facts,
          outcome: 'error',
          errorName: error.name,
        }),
    );
    record('body-decode-start', facts);
    try {
      const body = await response.json();
      record('body-decode-complete', {
        ...facts,
        returnedVersion:
          body?.layout_version ?? body?.lab?.layout_version ?? null,
        selectedPlacement:
          body?.nodes?.find(
            (node: { entity_id: string }) => node.entity_id === benchId,
          )?.placement ?? null,
        labsCount: Array.isArray(body?.data) ? body.data.length : null,
        targetLabVersion:
          body?.data?.find((entry: { id: string }) => entry.id === lab)
            ?.layout_version ?? null,
        code: body?.error?.code ?? null,
      });
    } catch (error) {
      record('body-decode-error', {
        ...facts,
        errorName: error instanceof Error ? error.name : 'OtherError',
      });
    }
  });
  await page.exposeFunction(
    '__labPeerSaveObservation',
    (kind: string, facts: Record<string, unknown>) => {
      if (kind === 'heartbeat') observation.beat(facts);
      else observation.dom(facts);
    },
  );
  mark('renderer-observer-install-start');
  const installation = await boundedBrowserFact(() =>
    page.mainFrame().evaluate(
      ({ lab, benchId }) => {
        const emit = (
          window as unknown as {
            __labPeerSaveObservation: (kind: string, facts: unknown) => void;
          }
        ).__labPeerSaveObservation;
        const nodeIds = new WeakMap<Element, number>();
        let nextId = 0,
          frames = 0,
          lastFrame = performance.now(),
          maxFrameGap = 0,
          previous = '';
        const sample = () => {
          const statuses = Array.from(
            document.querySelectorAll(
              '[role="status"][aria-label="布局保存状态"]',
            ),
          );
          const status = statuses[0];
          if (status && !nodeIds.has(status)) nodeIds.set(status, ++nextId);
          const label = Array.from(document.querySelectorAll('label')).find(
            (entry) => entry.textContent === 'X (m)',
          );
          const input = label
            ? (document.getElementById(
                label.htmlFor,
              ) as HTMLInputElement | null)
            : null;
          const buttons = Array.from(
            document.querySelectorAll(
              'button[aria-label="保存布局"],button[aria-label="重试保存"]',
            ),
          ) as HTMLButtonElement[];
          const storage: unknown[] = [];
          try {
            for (let index = 0; index < localStorage.length; index++) {
              const key = localStorage.key(index)!;
              if (!key.startsWith('lab-word.layout-draft.v1:')) continue;
              const value = JSON.parse(localStorage.getItem(key)!);
              if (value.scope?.labId !== lab) continue;
              const node = value.draft?.nodes?.find(
                (entry: { entity_id: string }) => entry.entity_id === benchId,
              );
              storage.push({
                format: value.format,
                version: value.draft?.version ?? null,
                selectedPlacement: node?.placement ?? null,
                rawX: node
                  ? (value.draft.coordinateText?.[`${node.id}-position-X`] ??
                    null)
                  : null,
              });
            }
          } catch (error) {
            storage.push({
              errorName: error instanceof Error ? error.name : 'OtherError',
            });
          }
          const facts = {
            statusCount: statuses.length,
            statusNodeId: status ? nodeIds.get(status) : null,
            connected: status?.isConnected ?? false,
            status: status?.textContent ?? null,
            statusHasRectangle: status
              ? status.getClientRects().length > 0
              : false,
            rawX: input?.value ?? null,
            saveButtonCount: buttons.length,
            saveDisabled: buttons[0]?.disabled ?? null,
            storage,
          };
          const encoded = JSON.stringify(facts);
          if (encoded !== previous) {
            previous = encoded;
            emit('dom', facts);
          }
          return facts;
        };
        const frame = (at: number) => {
          frames++;
          maxFrameGap = Math.max(maxFrameGap, at - lastFrame);
          lastFrame = at;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        new MutationObserver(sample).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-busy'],
        });
        setInterval(() => {
          const dom = sample();
          emit('heartbeat', {
            ...dom,
            frames,
            maxFrameGap,
            sinceFrameMs: performance.now() - lastFrame,
          });
        }, 1000);
        return sample();
      },
      { lab, benchId },
    ),
  );
  record('renderer-observer-install-ack', installation);
  let finished = false;
  // Node timer persists a control boundary even if the assertion's finally never runs.
  const watchdog = setTimeout(() => {
    if (finished) return;
    mark('live-boundary-start');
    void browserBoundary().then(
      (value) => {
        observation.finish({ phase: 'live-boundary', value });
        mark('live-boundary-end');
      },
      (error: Error) =>
        observation.finish({ phase: 'live-boundary', errorName: error.name }),
    );
  }, 10000);
  return async (phase: string) => {
    try {
      if (phase === 'failure') {
        mark('failure-boundary-start');
        observation.finish({ phase, boundary: await browserBoundary() });
        mark('failure-boundary-end');
      } else {
        finished = true;
        clearTimeout(watchdog);
        observation.finish({ phase, boundary: await browserBoundary() });
      }
    } catch (error) {
      observation.finish({
        phase,
        errorName: error instanceof Error ? error.name : 'OtherError',
      });
    }
  };
}
