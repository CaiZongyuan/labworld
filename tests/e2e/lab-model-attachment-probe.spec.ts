import { test } from '@playwright/test';
import { prepare } from './motion-support';
import { captureRenderWitness } from './render-witness';
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
test('model attachment probe: preserve failed capability and per-instance status', async ({
  page,
  browser,
}) => {
  test.setTimeout(45000);
  const world = await prepare(page, browser);
  try {
    await captureRenderWitness(page, 'model-load-first-view');
    await captureRenderWitness(world.second, 'model-load-second-view');
  } finally {
    await world.secondContext.close();
  }
});
