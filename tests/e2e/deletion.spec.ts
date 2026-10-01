import { expect, test } from '@playwright/test';

// The journey asserts the zh interface, so it pins the context locale
// instead of relying on device detection (see password-reset.spec.ts).
test('confirmed deletion hides attachments immediately and a Worker removes their objects', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill('deletion-browser@example.com');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.getByRole('link', { name: '我的文档', exact: true }).click();
  await page.getByRole('button', { name: '新建文档' }).click();
  await page.getByLabel('标题', { exact: true }).fill('删除旅程');
  await page.getByLabel('Markdown 正文').fill('将被删除的正文。');
  await page.getByRole('button', { name: '保存文档' }).click();
  await expect(page.getByLabel('选择附件')).toBeEnabled();
  const documentUrl = page.url();
  const complete = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname),
  );
  await page.getByLabel('选择附件').setInputFiles({
    name: 'gone.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('remove these bytes'),
  });
  await page.getByRole('button', { name: '上传附件' }).click();
  const file = await (await complete).json();
  await expect(
    page.getByRole('button', { name: '下载 gone.txt' }),
  ).toBeVisible();
  const documentId = new URL(documentUrl).pathname.split('/').at(-1)!;
  const downloadPath = `/api/v1/knowledge/documents/${documentId}/attachments/${file.id}/download`;
  const capability = await (await page.request.get(downloadPath)).json();
  await page.getByRole('button', { name: '删除附件 gone.txt' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('删除后无法恢复');
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('button', { name: '下载 gone.txt' })).toHaveCount(
    0,
  );
  expect((await page.request.get(downloadPath)).status()).toBe(404);
  await expect
    .poll(
      async () => {
        try {
          return (
            await fetch(capability.url, { signal: AbortSignal.timeout(2000) })
          ).status;
        } catch {
          return 0;
        }
      },
      {
        timeout: 15000,
        message: 'The deleted object should no longer be readable',
      },
    )
    .toBe(404);
  await page.getByRole('button', { name: '删除文档' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '确认删除' })
    .click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.goto(documentUrl);
  await expect(
    page.getByText('文档不存在，或你已失去访问权限。'),
  ).toBeVisible();
  expect(
    (
      await page.request.get(`/api/v1/knowledge/documents/${documentId}`)
    ).status(),
  ).toBe(404);
});
