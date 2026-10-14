import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreHttp } from '../support/core-http';
import { publishAsset } from '../support/lab-assets-http';
import {
  freshRenderMetrics,
  markRenderMetrics,
  waitForWorldVersion,
} from './fresh-render-metrics';

type StreamGateWindow = {
  renderStreamGate: { held: boolean; waiting: boolean; release: () => void };
};

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });

test('render metrics wait for the requested World while its real stream update is delayed', async ({
  page,
}) => {
  test.setTimeout(60000);
  const api = new CoreHttp(process.env.E2E_WEB_URL!);
  const email = `render-ready-${randomUUID()}@example.test`;
  await api.register(email);
  const draco = await publishAsset(
    api,
    await readFile('tests/fixtures/lab/cube-draco.glb'),
    'Readiness Draco',
  );
  const basis = await publishAsset(
    api,
    await readFile('tests/fixtures/lab/cube-basis.glb'),
    'Readiness Basis',
  );
  const lab = await api.json<{ id: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Render readiness Lab' },
    201,
  );
  const base = `/api/v1/lab/labs/${lab.id}`;
  const entity = await api.json<{ id: string }>(
    'POST',
    base + '/entities',
    {
      name: 'Readiness model',
      definition_id: 'model',
      definition_version: '1.0',
      reality: 'simulated',
      configuration: {},
      representation_id: draco.representation.id,
    },
    201,
  );
  await page.addInitScript(() => {
    const gate = { held: false, waiting: false, release: () => {} };
    Object.defineProperty(window, 'renderStreamGate', { value: gate });
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (
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
  await page.goto(`/lab?lab=${lab.id}`);
  const initial = await api.json<{ version: string }>('GET', base + '/world');
  await waitForWorldVersion(page, initial.version);
  await expect(
    page.locator('.world-page').getByLabel('三维视口', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await page.getByRole('button', { name: '性能', exact: true }).click();
  await expect(page.locator('.lab-perf')).toBeVisible();
  const mark = await markRenderMetrics(page);
  const baseline = await freshRenderMetrics(
    page,
    mark,
    performance.now() + 5000,
  );
  await page.evaluate(() => {
    (window as unknown as StreamGateWindow).renderStreamGate.held = true;
  });
  try {
    await api.json('PUT', base + `/entities/${entity.id}/appearance`, {
      representation_id: basis.representation.id,
    });
    const updated = await api.json<{ version: string }>('GET', base + '/world');
    await page.waitForFunction(
      () => (window as unknown as StreamGateWindow).renderStreamGate.waiting,
    );
    // The old World legitimately remains ready while the requested response is held.
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    let acknowledged = false;
    const readiness = waitForWorldVersion(page, updated.version).then(() => {
      acknowledged = true;
    });
    const oldMark = await markRenderMetrics(page);
    const oldSample = await freshRenderMetrics(
      page,
      oldMark,
      performance.now() + 5000,
    );
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        'render-world-readiness.json',
      ),
      JSON.stringify(
        {
          previousWorld: initial.version,
          requestedWorld: updated.version,
          heldUpdate: true,
          readinessAcknowledged: acknowledged,
          oldMark,
          oldSample,
        },
        null,
        2,
      ),
    );
    expect(acknowledged).toBe(false);
    await page.evaluate(() =>
      (window as unknown as StreamGateWindow).renderStreamGate.release(),
    );
    await readiness;
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const newMark = await markRenderMetrics(page);
    const deadline = performance.now() + 5000;
    await expect
      .poll(
        async () =>
          (await freshRenderMetrics(page, newMark, deadline)).textures,
      )
      .toBeGreaterThan(baseline.textures);
  } finally {
    await page.evaluate(() =>
      (window as unknown as StreamGateWindow).renderStreamGate.release(),
    );
  }
});
