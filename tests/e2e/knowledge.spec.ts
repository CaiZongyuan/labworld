import { expect, test } from '@playwright/test';

// The journeys assert the zh interface, so they pin the context locale
// instead of relying on device detection (same contract as
// password-reset.spec.ts, where a fresh Chromium otherwise reports en).
async function openZhPage(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ locale: 'zh-CN' });
  return context.newPage();
}

test('a newly registered Member writes Markdown and reads it after refresh', async ({
  browser,
}) => {
  const page = await openZhPage(browser);
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill('knowledge-member@example.com');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  // Registration lands on the example's default entry; the home view's role
  // badge is registration.spec.ts's concern, not this journey's.
  await expect(page.getByRole('heading', { name: '我的文档' })).toBeVisible();
  await page.getByRole('link', { name: '我的文档', exact: true }).click();
  await expect(page.getByText('暂无可访问的文档')).toBeVisible();
  await page.getByRole('button', { name: '新建文档' }).click();
  // Desktop width renders the two-pane editor: the preview live-syncs the
  // source without an explicit switch.
  await expect(page.locator('[data-editor-layout="wide"]')).toBeVisible();
  await page.getByLabel('标题', { exact: true }).fill('第一篇团队笔记');
  await page
    .getByLabel('Markdown 正文', { exact: true })
    .fill('# 起步\n\n来自真实 PostgreSQL。');
  await expect(page.getByRole('heading', { name: '起步' })).toBeVisible();
  // Narrowing the window collapses the same editor to tabs — the draft
  // survives because the panes are never remounted.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator('[data-editor-layout="narrow"]')).toBeVisible();
  await page.getByRole('tab', { name: '预览' }).click();
  await expect(page.getByRole('tabpanel', { name: '预览' })).toContainText(
    '起步',
  );
  await page.getByRole('button', { name: '保存文档' }).click();
  await expect(
    page.getByRole('heading', { name: '第一篇团队笔记' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '第一篇团队笔记' }),
  ).toBeVisible();
  await expect(page.locator('article')).toContainText('来自真实 PostgreSQL。');
  await page.getByRole('button', { name: '我的文档' }).click();
  await page.getByLabel('标题关键词').fill('团队');
  await page.getByLabel('标题关键词').press('Enter');
  await page.getByRole('button', { name: '第一篇团队笔记' }).click();
  await expect(
    page.getByRole('heading', { name: '第一篇团队笔记' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '起步' })).toBeVisible();
});

test('two pages preserve a conflicting draft and reconcile it explicitly', async ({
  browser,
}) => {
  const page = await openZhPage(browser);
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill('editing-member@example.com');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.getByRole('link', { name: '我的文档', exact: true }).click();
  await page.getByRole('button', { name: '新建文档' }).click();
  await page.getByLabel('标题', { exact: true }).fill('并发编辑示例');
  await page.getByLabel('Markdown 正文').fill('初始正文');
  await page.getByRole('button', { name: '保存文档' }).click();
  await page.getByRole('button', { name: '编辑文档' }).click();
  await expect(page.getByText('基于版本 1 编辑')).toBeVisible();
  // The conflicting tab shares the first page's session context.
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(other.getByText('基于版本 1 编辑')).toBeVisible();
  await other.getByLabel('Markdown 正文').fill('后保存的草稿');
  await other.getByRole('button', { name: '返回文档' }).click();
  await expect(other.getByRole('alertdialog')).toBeVisible();
  await other.getByRole('button', { name: '继续编辑' }).click();
  await page.getByLabel('Markdown 正文').fill('先保存的正文');
  await page.getByRole('button', { name: '保存文档' }).click();
  await expect(page.getByText('先保存的正文')).toBeVisible();
  await other.getByRole('button', { name: '保存文档' }).click();
  await expect(other.getByRole('alert')).toContainText('你的草稿已保留');
  await expect(other.getByLabel('Markdown 正文')).toHaveValue('后保存的草稿');
  await other.getByRole('button', { name: '读取最新版本' }).click();
  await expect(other.getByText('先保存的正文')).toBeVisible();
  await other.getByRole('button', { name: '已核对，保留草稿并继续' }).click();
  await other
    .getByLabel('Markdown 正文')
    .fill('先保存的正文\n\n已人工合并草稿');
  await other.getByRole('button', { name: '保存文档' }).click();
  await expect(other.getByText('版本 3', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('已人工合并草稿')).toBeVisible();
});
