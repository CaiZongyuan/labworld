import { readFile, rename, writeFile } from 'node:fs/promises';
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

test('a closed embedded database makes readiness fail while the process remains alive, then an owned restart recovers', async ({
  page,
  request,
}) => {
  const control = process.env.E2E_SERVICE_CONTROL!,
    reply = process.env.E2E_SERVICE_CONTROL_REPLY!,
    api = process.env.E2E_API_URL!;
  if (!control || !reply || !api)
    throw new Error('Run the isolated Node status profile');
  let revision = 0;
  async function requestControl(action: string) {
    await writeFile(
      control + '.next',
      JSON.stringify({ revision: ++revision, action }),
    );
    await rename(control + '.next', control);
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(reply, 'utf8')).revision;
        } catch {
          return 0;
        }
      })
      .toBe(revision);
  }
  await page.goto('/system');
  await expect(page.getByRole('heading', { name: '服务已就绪' })).toBeVisible();
  await requestControl('close-store');
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
    await requestControl('restart-service');
  }
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByRole('heading', { name: '服务已就绪' })).toBeVisible();
});
