import { expect, test } from '@playwright/test';

// The device language follows the browser in the product, so journeys that
// assert Chinese pin the locale explicitly instead of relying on the
// runner default (see password-reset.spec.ts).
test.use({ locale: 'zh-CN' });

test('an administrator traces a real Lab mutation by resource and request', async ({
  page,
}) => {
  await page.goto('/login');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(process.env.E2E_OWNER_EMAIL!);
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.E2E_OWNER_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/lab(?:\?|$)/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('private-body-not-in-audit');
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/lab/labs',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  const response = await created;
  expect(response.status()).toBe(201);
  const lab = await response.json();
  const requestId = response.headers()['x-request-id'];
  await expect(
    page.getByRole('button', { name: '登记对象', exact: true }),
  ).toBeEnabled();
  await page.goto('/audit');
  await page.getByLabel('资源 ID', { exact: true }).fill(lab.id);
  await page.getByLabel('动作', { exact: true }).fill('lab.create');
  await page.getByLabel('请求 ID', { exact: true }).fill(requestId);
  await page.getByRole('button', { name: '筛选记录' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'lab.create',
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(page.getByText(lab.id, { exact: true })).toBeVisible();
  await expect(
    page.getByText(requestId, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('private-body-not-in-audit')).toHaveCount(0);
});
