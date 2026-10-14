import { test, expect, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CoreHttp } from '../support/core-http';
import { publishAsset } from '../support/lab-assets-http';
import { expectInitialSceneReady } from './initial-scene-ready';
import { ModelAcquisitionOwnerObserver } from './model-acquisition-owner-observer';
import { receipt } from './motion-support';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });

test('model acquisition counter: end the old Canvas before counting target requests', async ({
  page,
}) => {
  test.setTimeout(60000);
  const blank = process.env.MODEL_ACQUISITION_BLANK_PRECONDITION === 'true';
  const observer = new ModelAcquisitionOwnerObserver();
  await observer.bind(page, 0);
  const api = new CoreHttp(process.env.E2E_WEB_URL!);
  const email = `model-owner-${randomUUID()}@example.test`;
  await api.register(email);
  const asset = await publishAsset(
    api,
    readFileSync('tests/fixtures/lab/cube.glb'),
    'Owner counter cube',
  );
  const lab = await api.json<{ id: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Owner counter Lab' },
    201,
  );
  const target = `/lab?lab=${lab.id}`;
  let releaseWorld!: () => void, releaseCapability!: () => void;
  const heldWorld = new Promise<void>((resolve) => {
    releaseWorld = resolve;
  });
  const heldCapability = new Promise<void>((resolve) => {
    releaseCapability = resolve;
  });
  let worldWaiting!: () => void, capabilityWaiting!: () => void;
  const worldRequested = new Promise<void>((resolve) => {
    worldWaiting = resolve;
  });
  const capabilityRequested = new Promise<void>((resolve) => {
    capabilityWaiting = resolve;
  });
  let oldDocument = true,
    holdWorld = true;
  let oldCapability: Request | undefined;
  page.on('requestfailed', (request) => {
    if (request === oldCapability) releaseCapability();
  });
  try {
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page
      .getByLabel('密码', { exact: true })
      .fill('contract-isolated-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/lab$/);
    await page.goto(target);
    await expectInitialSceneReady(page.locator('.world-page'));
    observer.phase(0, 'old-empty-Canvas-ready');
    await page.route(`**/api/v1/lab/labs/${lab.id}/world`, async (route) => {
      if (!holdWorld) {
        await route.continue();
        return;
      }
      holdWorld = false;
      const response = await route.fetch();
      worldWaiting();
      await heldWorld;
      try {
        await route.fulfill({ response });
      } catch (error) {
        if (!route.request().failure()) throw error;
      }
    });
    await page.route(
      `**/api/v1/lab/assets/${asset.id}/download`,
      async (route) => {
        if (!oldDocument) {
          await route.continue();
          return;
        }
        oldCapability = route.request();
        const response = await route.fetch();
        capabilityWaiting();
        await heldCapability;
        try {
          await route.fulfill({ response });
        } catch (error) {
          if (!route.request().failure()) throw error;
        }
      },
    );
    await api.json(
      'POST',
      `/api/v1/lab/labs/${lab.id}/motion-fixture`,
      { representation_id: asset.representation.id },
      201,
    );
    await worldRequested;
    if (blank) {
      oldDocument = false;
      await page.goto('about:blank');
      observer.phase(0, 'old-document-ended-before-counter');
    }
    const counts = { authorizations: 0, reads: 0 };
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === `/api/v1/lab/assets/${asset.id}/download`)
        counts.authorizations++;
      if (path === `/objects/${asset.representation.file_id}`) counts.reads++;
    });
    observer.phase(0, 'counter-attached');
    releaseWorld();
    if (!blank) {
      await capabilityRequested;
      observer.phase(0, 'old-Canvas-authorization-counted');
    }
    oldDocument = false;
    observer.phase(0, 'target-navigation-requested');
    await page.goto(target);
    releaseCapability();
    await expectInitialSceneReady(page.locator('.world-page'));
    await expect(page.locator('.world-render-error')).toHaveCount(0);
    receipt('model-acquisition-counterexample', { blank, counts });
    expect(counts).toEqual({ authorizations: 1, reads: 1 });
  } finally {
    releaseWorld();
    releaseCapability();
    await page.unrouteAll({ behavior: 'wait' });
    await observer.close();
  }
});
