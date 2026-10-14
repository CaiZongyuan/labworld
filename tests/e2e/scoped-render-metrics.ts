import { expect, type Page, type ElementHandle } from '@playwright/test';
import {
  readRenderMetrics,
  isFreshRenderMetricSample,
  remainingMetricBudget,
  type RenderMetricSample,
  type RenderMetricMark,
} from './fresh-render-metrics';
import { predicateFact } from './original-predicate-facts';

export type RenderMetricScope = {
  labId: string;
  labName: string;
  version: string;
  selection: number;
};

export async function requestedRenderMetricScope(
  page: Page,
  labId: string,
  selection: number,
  deadline: number,
): Promise<RenderMetricScope> {
  const response = await page.request.get(`/api/v1/lab/labs/${labId}/world`, {
    timeout: remainingMetricBudget(deadline),
  });
  expect(response.ok()).toBe(true);
  const world = await response.json();
  expect(world.lab.id).toBe(labId);
  return { labId, labName: world.lab.name, version: world.version, selection };
}

export async function scopedRenderMetrics(
  page: Page,
  scope: RenderMetricScope,
  deadline: number,
  predicate: (sample: RenderMetricSample) => boolean = () => true,
): Promise<RenderMetricSample> {
  let canvas: ElementHandle<HTMLCanvasElement> | null = null;
  let mark: RenderMetricMark | null = null;
  let bootstrap: RenderMetricSample | null = null;
  let accepted!: RenderMetricSample;
  const conditions = () =>
    canvas!.evaluate((element, expected) => {
      const root = document.querySelector('.world-page');
      const select = root?.querySelector<HTMLSelectElement>(
        'select[aria-label="打开 Lab"],select[aria-label="Open Lab"]',
      );
      const version = root?.querySelector(
        '[aria-label="世界版本"],[aria-label="World version"]',
      )?.textContent;
      const currentCanvas = root?.querySelector('canvas');
      const rectangle = element.getBoundingClientRect();
      const sameCanvas =
        element.isConnected &&
        currentCanvas === element &&
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        getComputedStyle(element).visibility !== 'hidden';
      return {
        sameCanvas,
        at: performance.now(),
        ready:
          sameCanvas &&
          select?.value === expected.labId &&
          root?.querySelector('.lab-heading h1')?.textContent ===
            expected.labName &&
          /^W\d+$/.test(version ?? '') &&
          BigInt(version!.slice(1)) >= BigInt(expected.version) &&
          root?.getAttribute('aria-busy') === 'false' &&
          !root.querySelector('.world-render-error') &&
          root.querySelectorAll(
            '.world-object-list input[type="checkbox"]:checked',
          ).length === expected.selection,
      };
    }, scope);
  try {
    await expect
      .poll(
        async () => {
          if (!canvas) {
            canvas = (await page.locator('.world-page canvas').elementHandle({
              timeout: remainingMetricBudget(deadline),
            })) as ElementHandle<HTMLCanvasElement> | null;
            if (!canvas) return false;
          }
          const before = await conditions();
          predicateFact('geometries', {
            stage: 'scope-condition',
            worldVersion: scope.version,
            ...before,
          });
          if (!before.sameCanvas) {
            await canvas.dispose();
            canvas = null;
            mark = null;
            bootstrap = null;
            return false;
          }
          if (!before.ready) {
            mark = null;
            bootstrap = null;
            return false;
          }
          mark ??= { sampledAt: before.at, completedRenderFrame: -1 };
          const sample = await readRenderMetrics(page);
          const after = await conditions();
          predicateFact('geometries', {
            stage: bootstrap ? 'scope-followup' : 'scope-bootstrap',
            mark,
            sample,
            ...after,
          });
          if (!after.ready) {
            mark = null;
            bootstrap = null;
            return false;
          }
          if (
            !sample ||
            !Number.isSafeInteger(sample.completedRenderFrame) ||
            sample.completedRenderFrame <= 0 ||
            !isFreshRenderMetricSample(sample, mark)
          )
            return false;
          if (!bootstrap) {
            bootstrap = sample;
            mark = {
              sampledAt: after.at,
              completedRenderFrame: sample.completedRenderFrame,
            };
            return false;
          }
          if (!predicate(sample)) return false;
          accepted = sample;
          return true;
        },
        { timeout: remainingMetricBudget(deadline) },
      )
      .toBe(true);
    return accepted;
  } finally {
    await (canvas as ElementHandle<HTMLCanvasElement> | null)?.dispose();
  }
}
