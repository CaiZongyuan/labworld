import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test('a real Worker creates a downloadable document ZIP with its attachment bytes', async ({
  browser,
}) => {
  // The journey asserts zh copy; a fresh Chromium reports en, so the
  // context pins the locale (see password-reset.spec.ts).
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill('export-browser@example.com');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.getByRole('link', { name: '我的文档', exact: true }).click();
  await page.getByRole('button', { name: '新建文档' }).click();
  await page.getByLabel('标题', { exact: true }).fill('可以带走的文档');
  await page.getByLabel('Markdown 正文').fill('# 原始文档\n\n带附件的正文。');
  await page.getByRole('button', { name: '保存文档' }).click();
  await expect(page.getByLabel('选择附件')).toBeEnabled();
  const bytes = Buffer.from('attachment from the real browser\n', 'utf8');
  await page
    .getByLabel('选择附件')
    .setInputFiles({ name: '资料.txt', mimeType: 'text/plain', buffer: bytes });
  await page.getByRole('button', { name: '上传附件' }).click();
  await expect(
    page.getByRole('button', { name: '下载 资料.txt' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '导出当前文档' }).click();
  await expect(page.getByRole('button', { name: '下载 ZIP' })).toBeVisible({
    timeout: 15000,
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载 ZIP' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^document-[0-9a-f-]+\.zip$/);
  const archive = unzipSync(await readFile((await download.path())!));
  expect(Object.keys(archive)).toHaveLength(2);
  expect(strFromU8(archive['document.md'])).toBe(
    '# 原始文档\n\n带附件的正文。',
  );
  const attachment = Object.keys(archive).find((name) =>
    /^attachments\/[0-9a-f-]+\.txt$/.test(name),
  );
  expect(attachment).toBeTruthy();
  expect(Buffer.from(archive[attachment!])).toEqual(bytes);
  await page.goto('/notifications');
  await expect(page.getByText('文档导出完成', { exact: true })).toBeVisible();
  await expect(page.getByText('1 条未读')).toBeVisible();
  await page.getByRole('button', { name: '查看结果' }).click();
  await expect(page.getByRole('heading', { name: '导出详情' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载 ZIP' })).toBeVisible();
  await page.getByRole('button', { name: '返回通知' }).click();
  await expect(page.getByText('0 条未读')).toBeVisible();
  await page.reload();
  await expect(page.getByText('已读', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看结果' })).toHaveCount(1);
});
