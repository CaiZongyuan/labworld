import { expect, test } from '@playwright/test';

// The device language follows the browser in the product, so journeys that
// assert Chinese pin the locale explicitly instead of relying on the
// runner default (see password-reset.spec.ts).
test.use({ locale: 'zh-CN' });

test('a Reader gains library access, an Editor can write, and revocation blocks the original browser', async ({
  browser,
  page,
}) => {
  const colleagueContext = await browser.newContext({ locale: 'zh-CN' });
  try {
    const colleague = await colleagueContext.newPage();
    await colleague.goto('/register');
    await colleague
      .getByLabel('邮箱', { exact: true })
      .fill('library-reader@example.com');
    await colleague
      .getByLabel('密码', { exact: true })
      .fill('browser-test-password');
    await colleague.getByRole('button', { name: '创建账号' }).click();
    // Registration lands on the documents entry; the session is live there.
    await expect(
      colleague.getByRole('heading', { name: '我的文档' }),
    ).toBeVisible();
    await page.goto('/login');
    await page
      .getByLabel('邮箱', { exact: true })
      .fill(process.env.E2E_OWNER_EMAIL!);
    await page
      .getByLabel('密码', { exact: true })
      .fill(process.env.E2E_OWNER_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('link', { name: '知识库', exact: true }).click();
    await page.getByLabel('知识库名称').fill('团队共享流程');
    await page.getByRole('button', { name: '创建共享知识库' }).click();
    await expect(
      page.getByRole('heading', { name: '团队共享流程', exact: true }),
    ).toBeVisible();
    const libraryUrl = page.url();
    await page.getByRole('button', { name: '新建文档' }).click();
    await page.getByLabel('标题', { exact: true }).fill('共享操作手册');
    await page.getByLabel('Markdown 正文').fill('仅向已授权成员开放。');
    await page.getByRole('button', { name: '保存文档' }).click();
    await expect(
      page.getByRole('heading', { name: '共享操作手册' }),
    ).toBeVisible();
    const documentUrl = page.url();
    await colleague.goto(documentUrl);
    await expect(colleague.getByRole('alert')).toContainText('文档不存在');
    await page.getByRole('button', { name: '所在知识库' }).click();
    await page
      .getByLabel('选择成员')
      .selectOption({ label: 'library-reader@example.com' });
    await page.getByRole('button', { name: '保存授权' }).click();
    await expect(
      page.getByText('library-reader@example.com · 只读'),
    ).toBeVisible();
    await colleague.goto(libraryUrl);
    await expect(colleague.getByText('只读知识库')).toBeVisible();
    await colleague.getByRole('button', { name: '共享操作手册' }).click();
    await expect(colleague.getByText('仅向已授权成员开放。')).toBeVisible();
    await expect(
      colleague.getByRole('button', { name: '编辑文档' }),
    ).toHaveCount(0);
    await page.getByLabel('访问权限').selectOption('editor');
    await page.getByRole('button', { name: '保存授权' }).click();
    await expect(
      page.getByText('library-reader@example.com · 可编辑'),
    ).toBeVisible();
    await colleague.reload();
    await colleague.getByRole('button', { name: '编辑文档' }).click();
    await colleague.getByLabel('Markdown 正文').fill('由 Editor 保存。');
    await colleague.getByRole('button', { name: '保存文档' }).click();
    await expect(colleague.getByText('由 Editor 保存。')).toBeVisible();
    await page
      .getByRole('button', { name: '撤销 library-reader@example.com 的授权' })
      .click();
    await expect(page.getByText('还没有额外授权')).toBeVisible();
    await colleague.reload();
    await expect(colleague.getByRole('alert')).toContainText('文档不存在');
    await colleague.goto(libraryUrl);
    await expect(colleague.getByRole('alert')).toContainText('知识库不存在');
  } finally {
    await colleagueContext.close();
  }
});
