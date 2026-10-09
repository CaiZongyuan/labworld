import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { launchApp, requireSmokeEnv, signIn } from './helpers';

/**
 * Desktop soak: drives the real shared views (document list → document
 * detail with its attachment panel — refresh, download, upload — and the
 * delete dialog → back) in a loop while sampling renderer RSS, JS heap,
 * DOM nodes and listener counts. The runner (scripts/perf/desktop-soak.mjs)
 * boots the disposable stack, seeds controlled data and shapes the report;
 * this spec only collects the time series. It runs from
 * tests/desktop/soak.config.ts, never from the shell smoke.
 */

const durationSecs = Number(process.env.DESKTOP_SOAK_DURATION_SECS ?? '300');
const warmupSecs = Number(process.env.DESKTOP_SOAK_WARMUP_SECS ?? '15');
const sampleMs = Number(process.env.DESKTOP_SOAK_SAMPLE_MS ?? '2000');
const documentCount = Number(process.env.DESKTOP_SOAK_DOCUMENT_COUNT ?? '8');

interface SoakSample {
  t: number;
  rendererRssKiB: number | null;
  heapKiB: number | null;
  domNodes: number;
  listeners: number | null;
}

// The listener counter wraps EventTarget before the app scripts run and
// tracks NET live registrations on LONG-LIVED targets only (window,
// document, body, documentElement, the React root container): a real
// listener leak accumulates exactly there, while registrations on
// transient targets (per-fetch signals, churned elements) are collected
// with their target and would only be noise for an identity-based
// counter. Same listener+type+capture dedupes like the DOM does, `once`
// listeners leave the count when they fire, and a signal abort releases
// what was registered with it (the abort hook goes through the raw
// addEventListener so it does not count itself).
const listenerShim = () => {
  const longLived = (target: EventTarget): boolean =>
    target === window ||
    target === document ||
    target === document.body ||
    target === document.documentElement ||
    (target instanceof Element && target.id === 'root');
  const counts = new Map<string, number>();
  const bump = (type: string, delta: number) =>
    counts.set(type, (counts.get(type) ?? 0) + delta);
  // target -> type -> capture -> listener -> registered callable
  const registry = new WeakMap<
    EventTarget,
    Map<
      string,
      Map<boolean, Map<EventListenerOrEventListenerObject, EventListener>>
    >
  >();
  const rawAdd = EventTarget.prototype.addEventListener;
  const rawRemove = EventTarget.prototype.removeEventListener;
  const readOptions = (o?: boolean | AddEventListenerOptions) =>
    typeof o === 'boolean'
      ? { capture: o, once: false, signal: undefined }
      : {
          capture: !!o?.capture,
          once: !!o?.once,
          signal: o?.signal as AbortSignal | undefined,
        };
  const unregister = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    capture: boolean,
  ) => {
    const entry = registry.get(target)?.get(type)?.get(capture)?.get(listener);
    if (!entry) return;
    registry.get(target)?.get(type)?.get(capture)?.delete(listener);
    bump(type, -1);
    try {
      rawRemove.call(target, type, entry, { capture });
    } catch {
      // The target may already be gone; the count adjustment above stands.
    }
  };
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (
      longLived(this) &&
      (typeof listener === 'function' ||
        (listener && typeof listener.handleEvent === 'function'))
    ) {
      const { capture, once, signal } = readOptions(options);
      let perType = registry.get(this)?.get(type);
      let perCapture = perType?.get(capture);
      if (!perType || !perCapture) {
        if (!registry.get(this)) registry.set(this, new Map());
        if (!perType) {
          perType = new Map();
          registry.get(this)!.set(type, perType);
        }
        perCapture = new Map();
        perType.set(capture, perCapture);
      }
      if (!perCapture.has(listener)) {
        const callable =
          typeof listener === 'function'
            ? listener
            : (event: Event) => listener.handleEvent(event);
        const registered = once
          ? function (this: EventTarget, event: Event) {
              unregister(this, type, listener, capture);
              return callable.call(this, event);
            }
          : callable;
        perCapture.set(listener, registered);
        bump(type, 1);
        if (signal) {
          try {
            rawAdd.call(
              signal,
              'abort',
              () => {
                unregister(this, type, listener, capture);
              },
              { once: true },
            );
          } catch {
            // A dead signal cannot fire; nothing to release later.
          }
        }
        return rawAdd.call(this, type, registered, {
          capture,
          once: false,
          signal,
        });
      }
    }
    return rawAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) {
    if (
      longLived(this) &&
      (typeof listener === 'function' ||
        (listener && typeof listener.handleEvent === 'function'))
    ) {
      const capture =
        typeof options === 'boolean' ? options : !!options?.capture;
      try {
        unregister(this, type, listener, capture);
      } catch {
        // Never let bookkeeping break the app's own removal.
      }
    }
    return rawRemove.call(this, type, listener, options);
  };
  (window as unknown as { __saasSoak: { count(): number } }).__saasSoak = {
    count: () => [...counts.values()].reduce((sum, n) => sum + n, 0),
  };
};

async function rendererMetrics(window: Page) {
  return window.evaluate(() => {
    const memory = (
      performance as Performance & { memory?: { usedJSHeapSize: number } }
    ).memory;
    return {
      heapKiB: memory ? Math.round(memory.usedJSHeapSize / 1024) : null,
      domNodes: document.getElementsByTagName('*').length,
      listeners:
        (
          window as unknown as { __saasSoak?: { count(): number } }
        ).__saasSoak?.count() ?? null,
    };
  });
}

async function rendererRssKiB(
  app: ElectronApplication,
): Promise<number | null> {
  return app.evaluate(({ app: electron }) => {
    // Electron 44 reports the renderer process type as 'Tab' in app
    // metrics (the old 'Renderer' name is gone from the union).
    const renderers = electron
      .getAppMetrics()
      .filter((metric) => metric.type === 'Tab');
    const total = renderers.reduce(
      (sum, metric) => sum + (metric.memory?.workingSetSize ?? 0),
      0,
    );
    return total > 0 ? total : null;
  });
}

// One realistic visit, sampled at its heaviest point: open a document from
// the list, refresh its attachment panel, download a seeded attachment when
// one is there, upload a fresh unique attachment through the real hashing
// and progress flow and delete it again once it shows up, toggle the delete
// dialog without deleting, then sample while the detail view is up before
// returning to the list. Upload-then-delete keeps the seeded data set
// stationary — the cycle exercises the full attachment round trip without
// growing the data it measures against, so runs and machines stay
// comparable. The fixture titles are deterministic, so the cycle walks
// them round-robin.
async function openDetail(window: Page, index: number, title: string) {
  await window.getByRole('button', { name: title }).first().click();
  await expect(window.getByRole('heading', { name: title })).toBeVisible({
    timeout: 15_000,
  });
  await window
    .getByRole('button', { name: '重新查询附件' })
    .click({ timeout: 15_000 });
  // Downloads only exist on documents that already carry attachments; the
  // button disables itself while the file is in flight, so re-enablement
  // is the completion signal (the first check may win that race — the
  // renderer work happens either way).
  const download = window.getByRole('button', { name: /^下载 / }).first();
  if (await download.isVisible().catch(() => false)) {
    await download.click();
    await expect(download).toBeEnabled({ timeout: 15_000 });
  }
  // A unique payload per cycle: the round trip exercises hashing, progress
  // and storage without leaning on any server-side dedupe behavior.
  const uploadName = `负载上传-${index}.txt`;
  await window.setInputFiles('#attachment-file', {
    name: uploadName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`桌面长测上传样本 ${index}\n`.repeat(256)),
  });
  await window.getByRole('button', { name: '上传附件' }).click();
  await expect(
    window.getByRole('status').filter({ hasText: '上传完成' }).first(),
  ).toBeVisible({ timeout: 30_000 });
  // Clean up behind the cycle: delete the attachment this visit added, so
  // the next visit measures the same document it started from.
  const removeAttachment = window.getByRole('button', {
    name: `删除附件 ${uploadName}`,
  });
  await removeAttachment.click({ timeout: 15_000 });
  await window
    .getByRole('button', { name: '确认删除' })
    .click({ timeout: 15_000 });
  await expect(removeAttachment).toBeHidden({ timeout: 15_000 });
  await window.getByRole('button', { name: '删除文档' }).click();
  await expect(
    window.getByRole('heading', { name: new RegExp('^删除') }),
  ).toBeVisible({ timeout: 15_000 });
  await window.getByRole('button', { name: '取消' }).click();
}

async function backToList(window: Page, title: string) {
  await window.getByRole('button', { name: '我的文档' }).click();
  await expect(window.getByRole('button', { name: title })).toBeVisible({
    timeout: 15_000,
  });
}

test('desktop soak collects a renderer resource time series', async () => {
  test.setTimeout((durationSecs + warmupSecs + 300) * 1000);
  const samplesPath = requireSmokeEnv('DESKTOP_SOAK_SAMPLES_PATH');
  const appOrigin = new URL(requireSmokeEnv('E2E_WEB_URL')).origin;
  const { app, window, cleanup } = await launchApp();
  const samples: SoakSample[] = [];
  let collectionError: unknown = null;
  try {
    await signIn(window);
    // The shim must wrap EventTarget before the app bundles execute, so
    // install it and reload once; every later navigation counts too.
    await window.addInitScript(listenerShim);
    await window.reload();
    await window.goto(`${appOrigin}/documents`);
    // Warm-up: first paint, hydration and route-level lazy chunks settle
    // here, so the series starts from a steady state, not from cold start.
    await window.waitForTimeout(warmupSecs * 1000);

    const started = Date.now();
    let lastSample = 0;
    for (
      let index = 0;
      (Date.now() - started) / 1000 < durationSecs;
      index += 1
    ) {
      const title = `负载样本 0-${index % documentCount}`;
      await openDetail(window, index, title);
      // Sample with the document detail (markdown, exports, attachments)
      // on screen — the heaviest moment of the cycle.
      if (Date.now() - lastSample >= sampleMs) {
        const metrics = await rendererMetrics(window);
        samples.push({
          t: Date.now() - started,
          rendererRssKiB: await rendererRssKiB(app),
          ...metrics,
        });
        lastSample = Date.now();
      }
      await backToList(window, title);
    }
  } catch (error) {
    // A failed cycle is still a partial series worth shaping; remember and
    // rethrow after the report survives.
    collectionError = error;
  } finally {
    mkdirSync(dirname(samplesPath), { recursive: true });
    writeFileSync(
      samplesPath,
      `${JSON.stringify({ sampleMs, warmupSecs, durationSecs, samples }, null, 2)}\n`,
    );
    await cleanup();
  }
  if (collectionError) throw collectionError;
  expect(samples.length).toBeGreaterThan(0);
});
