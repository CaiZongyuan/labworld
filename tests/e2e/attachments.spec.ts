import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('an uploaded RustFS image is previewed through an attachment reference and downloaded byte for byte', async ({
  browser,
}) => {
  // The journey asserts the zh interface, so it pins the context locale
  // instead of relying on device detection (see password-reset.spec.ts).
  const context = await browser.newContext({ locale: 'zh-CN' });
  const page = await context.newPage();
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQ6vj/HwAFIgKpyfy9eQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill('attachment-writer@example.com');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.getByRole('link', { name: '我的文档', exact: true }).click();
  await page.getByRole('button', { name: '新建文档' }).click();
  await page.getByLabel('标题', { exact: true }).fill('带图片的文档');
  await page.getByLabel('Markdown 正文').fill('一张受保护的图片。');
  await page.getByRole('button', { name: '保存文档' }).click();
  await expect(page.getByLabel('选择附件')).toBeEnabled();
  await page
    .getByLabel('选择附件')
    .setInputFiles({ name: '图示.png', mimeType: 'image/png', buffer: bytes });
  await page.getByRole('button', { name: '上传附件' }).click();
  await expect(
    page.getByRole('button', { name: '下载 图示.png' }),
  ).toBeVisible();
  // The published row carries its file-type icon with a localized name.
  await expect(page.getByRole('img', { name: '图片文件' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载 图示.png' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('图示.png');
  expect(await readFile((await download.path())!)).toEqual(bytes);
  await page.getByRole('button', { name: '编辑文档' }).click();
  await page.getByRole('button', { name: '插入引用' }).click();
  await expect(page.getByLabel('Markdown 正文')).toHaveValue(
    /attachment:[0-9a-f-]+/,
  );
  // The two-pane editor live-syncs the preview, so the inserted reference
  // resolves without an explicit mode switch.
  const image = page.getByRole('img', { name: '图示.png' });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  await page.getByRole('button', { name: '保存文档' }).click();
  await expect(page.getByRole('button', { name: '编辑文档' })).toBeVisible();
  await expect(page.getByText('版本 2', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('img', { name: '图示.png' })).toBeVisible();
});
