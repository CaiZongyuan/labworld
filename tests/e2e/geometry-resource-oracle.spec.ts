import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CoreHttp } from '../support/core-http';
import {
  scopedRenderMetrics,
  type RenderMetricScope,
} from './scoped-render-metrics';

const donors = JSON.parse(
  readFileSync('tests/fixtures/lab/resource-metric-donors.json', 'utf8'),
);
type Donor = {
  completedRenderFrame: number;
  geometries: number;
  textures: number;
};
type DonorWindow = Window & {
  oracleDonor: { publications: number; release: () => void; stop: () => void };
};

async function metricSurface(page: Page): Promise<RenderMetricScope> {
  const api = new CoreHttp(process.env.E2E_WEB_URL!);
  await api.register(`metric-donor-${randomUUID()}@example.test`);
  const lab = await api.json<{ id: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Metric donor fixture' },
    201,
  );
  const world = await api.json<{ version: string }>(
    'GET',
    `/api/v1/lab/labs/${lab.id}/world`,
  );
  // Public DOM metric boundary replay, using independent captured donors. This
  // fixture does not claim to render GLB geometry; the original case owns that.
  await page.setContent(
    `<section class="world-page" aria-busy="false"><div class="lab-heading"><h1>Metric donor fixture</h1></div><select aria-label="打开 Lab"><option value="${lab.id}" selected>Metric donor fixture</option></select><span aria-label="世界版本">W${world.version}</span><div class="world-object-list"></div><canvas width="100" height="100"></canvas><aside class="lab-perf" data-sampled-at="0" data-completed-render-frame="80" data-geometries="17" data-textures="4"></aside></section>`,
  );
  return {
    labId: lab.id,
    labName: 'Metric donor fixture',
    version: world.version,
    selection: 0,
  };
}
async function gatedDonors(
  page: Page,
  first: Donor,
  next: Donor,
  held = false,
) {
  await page.evaluate(
    ({ first, next, held }) => {
      const panel = document.querySelector<HTMLElement>('.lab-perf')!;
      let released = !held;
      const state = {
        publications: 0,
        release: () => {
          released = true;
        },
        stop: () => {},
      };
      const timer = window.setInterval(() => {
        const donor = released && state.publications > 0 ? next : first;
        panel.dataset.sampledAt = String(performance.now());
        for (const [field, value] of Object.entries(donor))
          panel.dataset[field] = String(value);
        if (released)
          panel.dataset.completedRenderFrame = String(
            donor.completedRenderFrame + Math.max(0, state.publications - 1),
          );
        state.publications++;
      }, 80);
      state.stop = () => window.clearInterval(timer);
      (window as unknown as DonorWindow).oracleDonor = state;
    },
    { first, next, held },
  );
}

test('resource metrics bootstrap a new Canvas with a lower completed-frame counter', async ({
  page,
}) => {
  const scope = await metricSurface(page);
  await gatedDonors(page, donors.newEmpty, donors.newEmptyNext);
  try {
    const sample = await scopedRenderMetrics(
      page,
      scope,
      performance.now() + 5000,
      (value) => value.geometries === 1,
    );
    expect(sample.geometries).toBe(1);
    expect(sample.completedRenderFrame).toBeLessThan(80);
  } finally {
    await page.evaluate(() =>
      (window as unknown as DonorWindow).oracleDonor.stop(),
    );
  }
});

test('resource metrics reject a fresh same-Canvas partial GLB donor', async ({
  page,
}) => {
  const scope = await metricSurface(page);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(
      '.lab-perf',
    )!.dataset.completedRenderFrame = '20';
  });
  await gatedDonors(page, donors.partial, donors.complete, true);
  let result: Awaited<ReturnType<typeof scopedRenderMetrics>> | undefined;
  const pending = scopedRenderMetrics(
    page,
    scope,
    performance.now() + 5000,
    (value) => value.geometries <= 31,
  ).then((sample) => {
    result = sample;
  });
  try {
    await page.waitForFunction(
      () => (window as unknown as DonorWindow).oracleDonor.publications >= 3,
      undefined,
      { polling: 50 },
    );
    expect(result).toBeUndefined();
    await page.evaluate(() =>
      (window as unknown as DonorWindow).oracleDonor.release(),
    );
    await pending;
    expect(result!.geometries).toBe(31);
    expect(result!.completedRenderFrame).toBeGreaterThan(
      donors.partial.completedRenderFrame,
    );
  } finally {
    await page.evaluate(() => {
      (window as unknown as DonorWindow).oracleDonor.release();
      (window as unknown as DonorWindow).oracleDonor.stop();
    });
    await pending.catch(() => {});
  }
});
