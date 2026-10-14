import type { Page, Request, Response } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedBrowserFact } from './lab-browser-facts.ts';

export function closedCategory(value: unknown, allowed: readonly string[]) {
  return typeof value === 'string' && allowed.includes(value)
    ? value
    : value == null
      ? null
      : 'unknown';
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const boolean = (value: unknown) => (typeof value === 'boolean' ? value : null);
const programStates = ['running', 'stopped', 'failed', 'interrupted'];
const taskStates = [
  'pending',
  'preparing',
  'running',
  'decelerating',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
];

export function gateProjection(
  value: unknown,
  entityId: string,
  kind: 'start' | 'world' | 'entity',
) {
  const body = object(value);
  const entity =
    kind === 'entity'
      ? body
      : object(
          Array.isArray(body.entities)
            ? body.entities.find((item) => object(item).id === entityId)
            : null,
        );
  const run = object(kind === 'start' ? body : entity.program_run);
  const task = object(entity.task);
  const capability = object(
    Array.isArray(entity.capabilities)
      ? entity.capabilities.find(
          (item) => object(item).id === 'centrifuge.start',
        )
      : null,
  );
  return {
    programStatus: closedCategory(run.status, programStates),
    taskStatus: closedCategory(task.status, taskStates),
    targetPresent: kind === 'start' ? null : entity.id === entityId,
    archived:
      kind === 'start' || entity.id !== entityId ? null : !!entity.archived_at,
    bindingImplemented: boolean(capability.binding_implemented),
    executable: boolean(capability.executable),
    capabilityReason: closedCategory(capability.reason, [
      'program_not_running',
      'binding_not_implemented',
      'runtime_unavailable',
    ]),
    errorCode: closedCategory(object(body.error).code, [
      'lab.runtime_unavailable',
      'lab.program_not_running',
      'lab.device_busy',
      'lab.capability_unavailable',
      'lab.unavailable',
      'auth.unavailable',
      'lab.entity_archived',
      'lab.session_owned_program',
      'lab.capability_not_implemented',
      'lab.invalid_parameters',
    ]),
    // Version strings stay numeric and bounded; identity references never leave memory.
    worldVersion:
      typeof body.version === 'string' &&
      /^(0|[1-9][0-9]{0,14})$/.test(body.version)
        ? Number(body.version)
        : null,
    entityCount: Array.isArray(body.entities) ? body.entities.length : null,
    nodeCount: Array.isArray(body.nodes) ? body.nodes.length : null,
  };
}

type Kind =
  | 'start'
  | 'world'
  | 'world-stream'
  | 'entity'
  | 'labs'
  | 'asset-download'
  | 'asset-metadata'
  | 'model'
  | 'object';
export function frontierRequestKind(
  path: string,
  method: string,
  base: string,
  entityId: string,
): Kind | null {
  if (
    path === base + '/entities/' + entityId + '/program/start' &&
    method === 'POST'
  )
    return 'start';
  if (method !== 'GET') return null;
  if (path === base + '/world') return 'world';
  if (path === base + '/world/subscribe') return 'world-stream';
  if (entityId && path === base + '/entities/' + entityId) return 'entity';
  if (path === '/api/v1/lab/labs') return 'labs';
  if (path.startsWith('/api/v1/lab/assets'))
    return path.endsWith('/download') ? 'asset-download' : 'asset-metadata';
  if (path.startsWith('/objects/')) return 'object';
  if (path.startsWith('/lab-assets/') && /\.(glb|wasm|js)$/.test(path))
    return 'model';
  return null;
}

/** Passive original traffic only. stop() freezes facts before any later readback. */
export function observeFrontierTraffic(
  page: Page,
  base: string,
  entityId = '',
) {
  type Projection = Awaited<
    ReturnType<typeof boundedBrowserFact<ReturnType<typeof gateProjection>>>
  >;
  type Row = {
    ordinal: number;
    kind: Kind;
    requestedAtMs: number;
    responseAtMs: number | null;
    httpStatus: number | null;
    failed: boolean;
    projection: Projection | null;
    projectionAtMs: number | null;
  };
  const rows: Row[] = [];
  const requests = new Map<Request, Row>();
  const pending = new Map<Row, Promise<Projection>>();
  let stopped = false,
    dropped = 0;
  const request = (value: Request) => {
    const kind = frontierRequestKind(
      new URL(value.url()).pathname,
      value.method(),
      base,
      entityId,
    );
    if (!kind || stopped) return;
    if (rows.length >= 64) {
      dropped++;
      return;
    }
    const row: Row = {
      ordinal: rows.length + 1,
      kind,
      requestedAtMs: performance.now(),
      responseAtMs: null,
      httpStatus: null,
      failed: false,
      projection: null,
      projectionAtMs: null,
    };
    rows.push(row);
    requests.set(value, row);
  };
  const response = (value: Response) => {
    const row = requests.get(value.request());
    if (!row || stopped) return;
    row.httpStatus = value.status();
    row.responseAtMs = performance.now();
    if (!['start', 'world', 'entity'].includes(row.kind)) return;
    const capture = boundedBrowserFact(async () => {
      const bytes = await value.body();
      if (bytes.length > 65536) throw new Error('Response projection bound');
      return gateProjection(
        JSON.parse(bytes.toString('utf8')),
        entityId,
        row.kind as 'start' | 'world' | 'entity',
      );
    });
    pending.set(row, capture);
    void capture
      .then((result) => {
        if (!stopped) {
          row.projection = result;
          row.projectionAtMs = performance.now();
        }
      })
      .catch(() => {});
  };
  const failed = (value: Request) => {
    const row = requests.get(value);
    if (row && !stopped) row.failed = true;
  };
  page.on('request', request);
  page.on('response', response);
  page.on('requestfailed', failed);
  return {
    stop() {
      stopped = true;
      page.off('request', request);
      page.off('response', response);
      page.off('requestfailed', failed);
      const atFailureMs = performance.now();
      const originalCallbackFacts = rows.map((row) => ({ ...row }));
      const unfinished = [...pending].filter(([row]) => !row.projection);
      requests.clear();
      pending.clear();
      return {
        atFailureMs,
        originalCallbackFacts,
        dropped,
        async postFailureOriginalResponseReadback() {
          return Promise.all(
            unfinished.map(async ([row, capture]) => ({
              ordinal: row.ordinal,
              kind: row.kind,
              projection: await capture,
              confirmedAtMs: performance.now(),
            })),
          );
        },
      };
    },
  };
}

/** These DOM confirmations occur after rejection; they are never the original assertion sample. */
export function frontierDomConfirmation(page: Page) {
  return boundedBrowserFact(() =>
    page.evaluate(() => {
      const root = document.querySelector('.world-page');
      const panel = root?.querySelector('.device-panel');
      const buttons = Array.from(
        panel?.querySelectorAll<HTMLButtonElement>('button') ?? [],
      );
      const start = buttons.find(
        (button) => button.textContent?.trim() === '开始离心',
      );
      const program = buttons.find((button) =>
        ['启动程序', '停止程序'].includes(button.textContent?.trim() ?? ''),
      );
      const states: Record<string, string> = {
        程序未启动: 'not-started',
        运行中: 'running',
        已停止: 'stopped',
        实时同步: 'live',
        正在连接: 'connecting',
        连接中断: 'offline',
        访问已结束: 'ended',
        正在请求来源变更: 'submitting',
        '来源已启动，等待此 Run 的新观测。': 'succeeded',
        '来源变更结果不确定。刷新状态后再决定下一步。': 'uncertain',
        等待执行: 'pending',
        准备中: 'preparing',
        计时中: 'running',
        减速中: 'decelerating',
      };
      const state = (element: Element | null | undefined) =>
        states[element?.textContent?.trim() ?? ''] ??
        (element ? 'unknown' : null);
      const busy = root?.getAttribute('aria-busy');
      return {
        browserMonotonicMs: performance.now(),
        rootPresent: !!root,
        busy: busy === 'true' ? true : busy === 'false' ? false : null,
        canvasCount: root?.querySelectorAll('canvas').length ?? 0,
        loadingCount: root?.querySelectorAll('.lab-loading').length ?? 0,
        renderErrorCount:
          root?.querySelectorAll('.world-render-error').length ?? 0,
        publicErrorCount:
          root?.querySelectorAll('.lab-error [role="alert"]').length ?? 0,
        objectCount: root?.querySelectorAll('.world-object').length ?? 0,
        startButtonPresent: !!start,
        startDisabled: start?.disabled ?? null,
        programDisabled: program?.disabled ?? null,
        programStatus: state(
          panel?.querySelector('.lab-section-heading [data-slot="badge"]'),
        ),
        sourcePhase: state(panel?.querySelector('p[role="status"]')),
        taskStatus: state(
          panel?.querySelector('.centrifuge-task [data-slot="badge"]'),
        ),
        runtimeUnavailableAlert: Array.from(
          panel?.querySelectorAll('[role="alert"]') ?? [],
        ).some((alert) => alert.textContent?.includes('运行端尚未就绪')),
        connectionStatus: state(
          root?.querySelector('.lab-heading [aria-live="polite"]'),
        ),
        privateLockFactorsKnown: false,
      };
    }),
  );
}

export async function captureFrontierFailure(
  name: 'centrifuge-enabled' | 'initial-render-ready',
  page: Page,
  observed: ReturnType<ReturnType<typeof observeFrontierTraffic>['stop']>,
  originalWorldRead: ReturnType<typeof gateProjection> | null = null,
) {
  try {
    const [postFailureDomConfirmation, postFailureOriginalResponseReadback] =
      await Promise.all([
        frontierDomConfirmation(page),
        observed.postFailureOriginalResponseReadback(),
      ]);
    const originalFacts = {
      atFailureMs: observed.atFailureMs,
      originalCallbackFacts: observed.originalCallbackFacts,
      dropped: observed.dropped,
    };
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        `browser-${name}-failure.json`,
      ),
      JSON.stringify(
        {
          originalTimeoutMs: 5000,
          originalAssertionRejected: true,
          originalWorldRead,
          ...originalFacts,
          postFailureDomConfirmation,
          postFailureOriginalResponseReadback,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    /* Evidence must preserve the original rejection. */
  }
}

/** Decode only the PNGs already captured by the original masked equality assertions. */
export function originalMaskedCaptureDimensions(captures: Buffer[]) {
  return captures.map((bytes) => {
    const valid =
      bytes.length >= 24 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.subarray(12, 16).toString('ascii') === 'IHDR';
    return {
      width: valid ? bytes.readUInt32BE(16) : null,
      height: valid ? bytes.readUInt32BE(20) : null,
    };
  });
}

export function originalMaskedCaptureFacts(page: Page, captures: Buffer[]) {
  return boundedBrowserFact(() =>
    page.evaluate(
      async (encoded) =>
        Promise.all(
          encoded.map(async (bytes) => {
            const image = new Image();
            image.src = 'data:image/png;base64,' + bytes;
            await image.decode();
            const raster = document.createElement('canvas');
            raster.width = image.width;
            raster.height = image.height;
            const context = raster.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(
              0,
              0,
              raster.width,
              raster.height,
            ).data;
            let green = 0,
              purple = 0;
            for (let y = 0; y < image.height; y += 2)
              for (let x = 0; x < image.width; x += 2) {
                const index = (y * image.width + x) * 4,
                  r = pixels[index],
                  g = pixels[index + 1],
                  b = pixels[index + 2];
                if (g > 60 && g > r * 1.3 && g > b * 1.3) green++;
                if (r > 60 && b > 60 && r > g * 1.4 && b > g * 1.4) purple++;
              }
            return { width: image.width, height: image.height, green, purple };
          }),
        ),
      captures.map((bytes) => bytes.toString('base64')),
    ),
  );
}
