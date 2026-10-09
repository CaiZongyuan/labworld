import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

// These public endpoints use fresh contexts and never handle credentials.
// The device language follows the browser in the product, so journeys that
// assert Chinese pin the locale explicitly instead of relying on the
// runner default (see password-reset.spec.ts).
test.use({
  locale: 'zh-CN',
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
});

test('page, generated SDK, API and migrated PostgreSQL form one real request', async ({
  page,
}) => {
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/api/v1/system/status'),
  );
  await page.goto('/system');
  const api = await response;
  expect(api.status()).toBe(200);
  expect(api.headers()['x-request-id']).toBeTruthy();
  expect(await api.json()).toMatchObject({
    database: 'connected',
    schema_version: expect.any(Number),
    status: 'ok',
  });
  await expect(page.getByRole('heading', { name: '服务已就绪' })).toBeVisible();
  await expect(page.getByText('PostgreSQL 已连接')).toBeVisible();
  await expect(
    page.getByRole('link', { name: '阅读入门教程' }),
  ).toHaveAttribute('href', /https:\/\//);
  await page.screenshot({
    path: 'test-results/status-ready.png',
    fullPage: true,
  });
});

test('a paused database makes readiness fail while the process remains alive, then recovers', async ({
  page,
  request,
}) => {
  const container = process.env.TEST_PG_CONTAINER;
  const api = process.env.E2E_API_URL;
  if (!container?.startsWith('labos-threejs-test-') || !api)
    throw new Error('Run via just e2e to provide isolated services');
  await page.goto('/system');
  await expect(page.getByRole('heading', { name: '服务已就绪' })).toBeVisible();
  execFileSync('docker', ['pause', container], { stdio: 'ignore' });
  try {
    expect((await request.get(`${api}/health/live`)).status()).toBe(200);
    expect(
      (await request.get(`${api}/health/ready`, { timeout: 8_000 })).status(),
    ).toBe(503);
    await page.getByRole('button', { name: '重新检查' }).click();
    await expect(page.getByRole('alert')).toContainText('暂时无法连接服务', {
      timeout: 8_000,
    });
  } finally {
    execFileSync('docker', ['unpause', container], { stdio: 'ignore' });
  }
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByRole('heading', { name: '服务已就绪' })).toBeVisible();
});
