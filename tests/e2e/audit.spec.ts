import { expect, test } from '@playwright/test';

// The device language follows the browser in the product, so journeys that
// assert Chinese pin the locale explicitly instead of relying on the
// runner default (see password-reset.spec.ts).
test.use({ locale: 'zh-CN' });

test('an administrator traces a real document mutation by resource and request', async ({
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
  await page.getByRole('link', { name: '我的文档', exact: true }).click();
  await page.getByRole('button', { name: '新建文档' }).click();
  await page.getByLabel('标题', { exact: true }).fill('审计教程');
  await page.getByLabel('Markdown 正文').fill('private-body-not-in-audit');
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/knowledge/documents',
  );
  await page.getByRole('button', { name: '保存文档' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const document = await response.json();
  const requestId = response.headers()['x-request-id'];
  await expect(
    page.getByRole('heading', { name: '审计教程', exact: true }),
  ).toBeVisible();
  await page.goto('/audit');
  await page.getByLabel('资源 ID', { exact: true }).fill(document.id);
  await page
    .getByLabel('动作', { exact: true })
    .fill('knowledge.document.create');
  await page.getByLabel('请求 ID', { exact: true }).fill(requestId);
  await page.getByRole('button', { name: '筛选记录' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'knowledge.document.create',
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(page.getByText(document.id, { exact: true })).toBeVisible();
  await expect(
    page.getByText(requestId, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('private-body-not-in-audit')).toHaveCount(0);
});
