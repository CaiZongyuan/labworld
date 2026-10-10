import { expect } from '@playwright/test';
import { displayed } from './motion-oracle';
import {
  prepare,
  metrics,
  eventually,
  receipt,
  joinViewer,
  ready,
} from './motion-support';

type World = Awaited<ReturnType<typeof prepare>>;
type Metrics = Awaited<ReturnType<typeof metrics>>;

// Resource counters include selected-object helpers. Hard navigation clears
// selection, so return to the same public scene state before exact comparison.
export async function assertResourceConvergence(world: World) {
  const viewer = world.second;
  const readings: Record<string, unknown>[] = [];
  const resources = [];
  let cycle = 0;
  let phase = 'loaded';
  let last: Metrics | undefined;
  let loadedMetrics: Metrics | undefined;
  const record = async (value: Metrics) => {
    const inspector = viewer.getByRole('complementary', { name: '对象信息' });
    readings.push({
      cycle,
      phase,
      metrics: value,
      selectedEntity: new URL(viewer.url()).searchParams.get('entity'),
      inspectorVisible: await inspector.isVisible(),
    });
    receipt('motion-resource-progress', { readings });
  };
  try {
    await expect(
      viewer.getByRole('complementary', { name: '对象信息' }),
    ).toContainText('Synthetic body 01');
    loadedMetrics = await metrics(viewer);
    await record(loadedMetrics);
    const empty = await world.api.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Empty motion resource Lab' },
      201,
    );
    for (cycle = 0; cycle < 3; cycle++) {
      phase = 'empty';
      await viewer.goto(`/lab?lab=${empty.id}`);
      await expect(viewer.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect.poll(() => displayed(viewer)).toBeNull();
      await viewer.getByRole('button', { name: '性能', exact: true }).click();
      const emptyMetrics = await eventually(
        async () => (last = await metrics(viewer)),
        (value) =>
          Number(value.stats.Geometries) <
          Number(loadedMetrics!.stats.Geometries),
      );
      await record(emptyMetrics);
      resources.push({ state: 'empty', metrics: emptyMetrics });
      phase = 'return';
      await viewer.goto(`/lab?lab=${world.fixture.lab_id}`);
      await expect(viewer.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await viewer.getByRole('button', { name: '性能', exact: true }).click();
      await joinViewer(viewer, 30);
      await ready(viewer);
      const directory = viewer.getByRole('button', {
        name: '打开对象目录',
        exact: true,
      });
      if ((await directory.getAttribute('aria-expanded')) === 'false')
        await directory.click();
      await viewer
        .getByRole('button', { name: '选择 Synthetic body 01', exact: true })
        .click();
      await expect(
        viewer.getByRole('complementary', { name: '对象信息' }),
      ).toContainText('Synthetic body 01');
      phase = 'next-loaded-selected';
      const nextLoadedMetrics = await eventually(
        async () => (last = await metrics(viewer)),
        (value) =>
          value.stats.Geometries === loadedMetrics!.stats.Geometries &&
          value.stats.Textures === loadedMetrics!.stats.Textures,
      );
      await record(nextLoadedMetrics);
      resources.push({ state: 'loaded', metrics: nextLoadedMetrics });
    }
    phase = 'restored';
    const restoredMetrics = await metrics(viewer);
    expect(restoredMetrics.stats.Geometries).toBe(
      loadedMetrics.stats.Geometries,
    );
    expect(restoredMetrics.stats.Textures).toBe(loadedMetrics.stats.Textures);
    await record(restoredMetrics);
    return { loadedMetrics, restoredMetrics, resources };
  } catch (error) {
    try {
      receipt('motion-resource-error', {
        cycle,
        phase,
        loadedMetrics,
        last,
        readings,
        selectedEntity: new URL(viewer.url()).searchParams.get('entity'),
      });
    } catch {
      /* Evidence failure cannot replace the original verification failure. */
    }
    throw error;
  }
}
