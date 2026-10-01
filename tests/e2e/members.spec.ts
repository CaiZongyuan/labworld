import { expect, test } from '@playwright/test';

// The device language follows the browser in the product, so journeys that
// assert Chinese pin the locale explicitly instead of relying on the
// runner default (see password-reset.spec.ts).
test.use({ locale: 'zh-CN' });

test('an Owner manages a member and disabling invalidates the original browser session', async ({
  browser,
  page,
}) => {
  const colleagueContext = await browser.newContext({ locale: 'zh-CN' });
  try {
    const colleague = await colleagueContext.newPage();
    await colleague.goto('/register');
    await colleague
      .getByLabel('邮箱', { exact: true })
      .fill('managed-colleague@example.com');
    await colleague
      .getByLabel('密码', { exact: true })
      .fill('browser-test-password');
    await colleague.getByRole('button', { name: '创建账号' }).click();
    // Registration lands on the documents entry; the member badge and
    // sign-out control this journey asserts on live on the home view.
    await expect(
      colleague.getByRole('heading', { name: '我的文档' }),
    ).toBeVisible();
    await colleague.getByRole('link', { name: '首页' }).click();
    await expect(
      colleague.getByRole('button', { name: '退出登录' }),
    ).toBeVisible();
    await page.goto('/login');
    await page
      .getByLabel('邮箱', { exact: true })
      .fill(process.env.E2E_OWNER_EMAIL!);
    await page
      .getByLabel('密码', { exact: true })
      .fill(process.env.E2E_OWNER_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('link', { name: '企业成员' }).click();
    const member = page.getByRole('article', {
      name: 'managed-colleague@example.com',
    });
    await member.getByLabel('角色', { exact: true }).selectOption('admin');
    await member.getByRole('button', { name: '保存成员' }).click();
    await expect(member.getByRole('status')).toHaveText('成员已保存');
    await colleague.reload();
    await expect(colleague.getByText('管理员', { exact: true })).toBeVisible();
    await member.getByRole('switch', { name: '启用成员' }).click();
    await member.getByRole('button', { name: '保存成员' }).click();
    await expect(member.getByText('已停用')).toBeVisible();
    await colleague.reload();
    await expect(
      colleague.getByText('当前没有有效会话，请登录或创建账号。'),
    ).toBeVisible();
    await member.getByRole('switch', { name: '启用成员' }).click();
    await member.getByRole('button', { name: '保存成员' }).click();
    await expect(member.getByText('已启用')).toBeVisible();
    await colleague.reload();
    await expect(
      colleague.getByRole('button', { name: '退出登录' }),
    ).toHaveCount(0);
  } finally {
    await colleagueContext.close();
  }
});
