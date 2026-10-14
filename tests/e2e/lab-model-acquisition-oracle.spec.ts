import { test, expect, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CoreHttp } from '../support/core-http';
import { publishAsset } from '../support/lab-assets-http';
import { expectInitialSceneReady } from './initial-scene-ready';
import { ModelAcquisitionOwnerObserver } from './model-acquisition-owner-observer';
import { receipt } from './motion-support';
import { waitForWorldVersion } from './fresh-render-metrics';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
type WorldGateWindow = {
  modelWorldGate: { held: boolean; waiting: boolean; release: () => void };
};

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
  let capabilityWaiting!: () => void;
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
    await page.addInitScript(() => {
      const gate = { held: false, waiting: false, release: () => {} };
      Object.defineProperty(window, 'modelWorldGate', { value: gate });
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        const path = new URL(response.url).pathname;
        if (
          !path.endsWith('/world/subscribe') ||
          !response.headers.get('content-type')?.startsWith('text/event-stream')
        )
          return response;
        const reader = response.body!.getReader();
        const body = new ReadableStream({
          async pull(controller) {
            const item = await reader.read();
            if (gate.held && !item.done) {
              gate.waiting = true;
              await new Promise<void>((resolve) => {
                gate.release = () => {
                  gate.held = false;
                  resolve();
                };
              });
              gate.waiting = false;
            }
            if (item.done) controller.close();
            else controller.enqueue(item.value);
          },
          cancel() {
            gate.release();
            return reader.cancel();
          },
        });
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      };
    });
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page
      .getByLabel('密码', { exact: true })
      .fill('contract-isolated-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/lab$/);
    await page.goto(target);
    const initialWorld = await api.json<{ version: string; nodes: unknown[] }>(
      'GET',
      `/api/v1/lab/labs/${lab.id}/world`,
    );
    expect(initialWorld.nodes).toHaveLength(0);
    await waitForWorldVersion(page, initialWorld.version);
    await expect(
      page.getByRole('heading', { name: 'Owner counter Lab', exact: true }),
    ).toBeVisible();
    await expectInitialSceneReady(page.locator('.world-page'));
    await expect(page.locator('.world-page canvas')).toBeVisible();
    observer.phase(0, 'old-empty-Canvas-ready');
    await page.route(`**/api/v1/lab/labs/${lab.id}/world`, async (route) => {
      if (!oldDocument || !holdWorld) {
        await route.continue();
        return;
      }
      holdWorld = false;
      const response = await route.fetch();
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
    await page.evaluate(() => {
      (window as unknown as WorldGateWindow).modelWorldGate.held = true;
    });
    await api.json(
      'POST',
      `/api/v1/lab/labs/${lab.id}/motion-fixture`,
      { representation_id: asset.representation.id },
      201,
    );
    const requestedWorld = await api.json<{
      version: string;
      nodes: unknown[];
    }>('GET', `/api/v1/lab/labs/${lab.id}/world`);
    expect(requestedWorld.nodes).toHaveLength(20);
    await page.waitForFunction(
      () => (window as unknown as WorldGateWindow).modelWorldGate.waiting,
      undefined,
      { polling: 50 },
    );
    await expect(page.getByLabel('世界版本', { exact: true })).toHaveText(
      `W${initialWorld.version}`,
    );
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    receipt('model-counter-world-gate', {
      initialVersion: initialWorld.version,
      requestedVersion: requestedWorld.version,
      originalNodes: 0,
      requestedNodes: 20,
      held: true,
    });
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
      await page.evaluate(() =>
        (window as unknown as WorldGateWindow).modelWorldGate.release(),
      );
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
