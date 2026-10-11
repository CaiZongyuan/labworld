import { expect, type Page } from '@playwright/test';

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
  await expect
    .poll(
      async () => {
        const sample = await page.evaluate(() => {
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
        if (
          !sample ||
          sample.sampledAt <= mark.sampledAt ||
          sample.completedRenderFrame <= mark.completedRenderFrame
        )
          return false;
        accepted = sample;
        return true;
      },
      { timeout: remainingMetricBudget(deadline) },
    )
    .toBe(true);
  return accepted!;
}
