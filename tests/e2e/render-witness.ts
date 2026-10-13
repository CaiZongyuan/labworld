import type { Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedBrowserFact } from './lab-browser-facts';

/** Diagnostic branch only: safe counters and geometry, without requesting a render. */
export async function captureRenderWitness(page: Page, name: string) {
  const capture = await boundedBrowserFact(() =>
    page.evaluate(() => {
      const canvas =
        document.querySelector<HTMLCanvasElement>('.world-page canvas');
      const panel = document.querySelector<HTMLElement>('.lab-perf');
      const viewport = document.querySelector<HTMLElement>('.world-viewport');
      const world = document.querySelector<HTMLElement>('.world-page');
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('button'),
      ].find((item) =>
        ['性能', 'Performance'].includes(item.getAttribute('aria-label') ?? ''),
      );
      const rect = canvas?.getBoundingClientRect();
      const stats: Record<string, number | null> = {};
      for (const row of panel?.querySelectorAll('.lab-perf-stats > div') ??
        []) {
        const key = row.querySelector('dt')?.textContent ?? '';
        if (
          ![
            'Draw calls',
            '三角形',
            'Triangles',
            'Geometries',
            'Textures',
          ].includes(key)
        )
          continue;
        const value = Number(
          row.querySelector('dd')?.textContent?.replaceAll(',', ''),
        );
        stats[key] = Number.isFinite(value) ? value : null;
      }
      const surface = canvas as
        | (HTMLCanvasElement & {
            getRenderSceneDiagnostics?: () => unknown;
            getRenderMetricProgress?: () => unknown;
          })
        | null;
      return {
        browserAt: performance.now(),
        documentEpoch: performance.timeOrigin,
        documentVisibility: document.visibilityState,
        worldPresent: !!world,
        worldBusy: world?.getAttribute('aria-busy'),
        viewportHidden: viewport?.hidden,
        lazyLoading: !!world?.querySelector('.lab-loading'),
        renderError: !!world?.querySelector('.world-render-error'),
        renderBoundaryError: viewport?.dataset.renderBoundaryError,
        renderBoundaryReason: viewport?.dataset.renderBoundaryReason,
        webglAvailable: typeof WebGL2RenderingContext !== 'undefined',
        canvas: rect
          ? {
              width: rect.width,
              height: rect.height,
              connected: canvas!.isConnected,
              cssDisplay: getComputedStyle(canvas!).display,
              cssVisibility: getComputedStyle(canvas!).visibility,
              centerExposed:
                document.elementFromPoint(
                  rect.x + rect.width / 2,
                  rect.y + rect.height / 2,
                ) === canvas,
            }
          : null,
        performanceButton: button
          ? {
              pressed: button.getAttribute('aria-pressed'),
              disabled: button.disabled,
            }
          : null,
        panel: panel
          ? {
              sampledAt: panel.dataset.sampledAt,
              completedRenderFrame: panel.dataset.completedRenderFrame,
              geometries: panel.dataset.geometries,
              textures: panel.dataset.textures,
              width: panel.getBoundingClientRect().width,
              height: panel.getBoundingClientRect().height,
              stats,
            }
          : null,
        rawRenderer: surface?.getRenderSceneDiagnostics?.(),
        sampler: surface?.getRenderMetricProgress?.(),
      };
    }),
  );
  try {
    appendFileSync(
      join(process.env.LAB_NODE_EVIDENCE ?? 'test-results', name + '.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), capture }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Diagnostic I/O cannot replace the original test verdict.
  }
}
