import { expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A ready previous World does not acknowledge a newly requested appearance. */
export async function waitForWorldVersion(page: Page, version: string) {
  await expect
    .poll(async () => {
      const displayed = await page
        .getByLabel(/^(世界版本|World version)$/)
        .innerText();
      return (
        /^W[0-9]+$/.test(displayed) &&
        BigInt(displayed.slice(1)) >= BigInt(version)
      );
    })
    .toBe(true);
}

export type RenderMetricSample = {
  sampledAt: number;
  completedRenderFrame: number;
  geometries: number;
  textures: number;
};
export type RenderMetricMark = Pick<
  RenderMetricSample,
  'sampledAt' | 'completedRenderFrame'
>;

export function isFreshRenderMetricSample(
  sample: RenderMetricSample | null,
  mark: RenderMetricMark,
): sample is RenderMetricSample {
  return (
    !!sample &&
    sample.sampledAt > mark.sampledAt &&
    sample.completedRenderFrame > mark.completedRenderFrame
  );
}

export function readRenderMetrics(
  page: Page,
): Promise<RenderMetricSample | null> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.lab-perf');
    if (!panel) return null;
    const fields = [
      'sampledAt',
      'completedRenderFrame',
      'geometries',
      'textures',
    ] as const;
    if (
      fields.some(
        (field) =>
          panel.dataset[field] === undefined ||
          !Number.isFinite(Number(panel.dataset[field])),
      )
    )
      return null;
    return {
      sampledAt: Number(panel.dataset.sampledAt),
      completedRenderFrame: Number(panel.dataset.completedRenderFrame),
      geometries: Number(panel.dataset.geometries),
      textures: Number(panel.dataset.textures),
    };
  });
}

/** Mark after the required visible result; compare only clocks from this browser. */
export function markRenderMetrics(page: Page): Promise<RenderMetricMark> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.lab-perf');
    const frame = panel?.dataset.completedRenderFrame;
    if (frame === undefined || !Number.isFinite(Number(frame)))
      throw new Error('Missing completed-render metrics');
    return {
      sampledAt: performance.now(),
      completedRenderFrame: Number(frame),
    };
  });
}

/** Freshness and the caller's original count comparison consume one deadline. */
export function remainingMetricBudget(deadline: number) {
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    throw new Error('Original render-metric comparison deadline expired');
  return remaining;
}

export async function freshRenderMetrics(
  page: Page,
  mark: RenderMetricMark,
  deadline: number,
): Promise<RenderMetricSample> {
  let accepted: RenderMetricSample | undefined;
  let lastSample: RenderMetricSample | null = null;
  try {
    await expect
      .poll(
        async () => {
          const sample = await readRenderMetrics(page);
          lastSample = sample;
          if (!isFreshRenderMetricSample(sample, mark)) return false;
          accepted = sample;
          return true;
        },
        { timeout: remainingMetricBudget(deadline) },
      )
      .toBe(true);
    return accepted!;
  } catch (error) {
    // Safe counters survive the next Playwright profile clearing test-results.
    try {
      writeFileSync(
        join(
          process.env.LAB_NODE_EVIDENCE ?? 'test-results',
          'fresh-render-metrics-failure.json',
        ),
        JSON.stringify(
          { mark, lastSample, remainingMs: deadline - performance.now() },
          null,
          2,
        ),
      );
    } catch {
      // Evidence failure must not replace the original metric failure.
    }
    throw error;
  }
}
