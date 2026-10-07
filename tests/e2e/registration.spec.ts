import { expect, test } from '@playwright/test';

test('two browsers register, refresh, log out and sign in with isolated sessions', async ({
  browser,
}) => {
  // The device language follows the browser in the product, so journeys that
  // assert Chinese pin the locale explicitly instead of relying on the
  // runner default (see password-reset.spec.ts).
  const first = await browser.newContext({ locale: 'zh-CN' });
  const second = await browser.newContext({ locale: 'zh-CN' });
  try {
    for (const [context, email] of [
      [first, 'first-member@example.com'],
      [second, 'member@example.com'],
    ] as const) {
      const page = await context.newPage();
      await page.goto('/register');
      await page.getByLabel('邮箱', { exact: true }).fill(email);
      await page
        .getByLabel('密码', { exact: true })
        .fill('browser-test-password');
      await page.getByRole('button', { name: '创建账号' }).click();
      // Registration lands directly on Lab, and the session
      // must survive a reload there.
      await expect(page).toHaveURL(/\/lab(?:\?|$)/);
      await page.reload();
      await expect(page).toHaveURL(/\/lab(?:\?|$)/);
      const cookie = (await context.cookies()).find(
        (cookie) => cookie.name === 'labos_threejs_session',
      );
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe('Lax');
      expect(await page.evaluate(() => document.cookie)).not.toContain(
        'labos_threejs_session',
      );
      // The fresh-member role badge and the sign-out control live on the
      // generic home view.
      await page.getByRole('link', { name: '首页' }).click();
      await expect(page.getByText('成员', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '退出登录' }).click();
      await expect(
        page.getByRole('link', { name: '登录', exact: true }),
      ).toBeVisible();
      const oldSession = await context.request.get('/api/v1/auth/session', {
        headers: { cookie: `labos_threejs_session=${cookie!.value}` },
      });
      expect(oldSession.status()).toBe(401);
      await page.getByRole('link', { name: '登录', exact: true }).click();
      await page.getByLabel('邮箱', { exact: true }).fill(email);
      await page
        .getByLabel('密码', { exact: true })
        .fill('browser-test-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page).toHaveURL(/\/lab(?:\?|$)/);
      expect(
        await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
          }),
        ),
      ).not.toContain('browser-test-password');
    }
    expect((await first.cookies())[0]?.value).not.toEqual(
      (await second.cookies())[0]?.value,
    );
  } finally {
    await first.close();
    await second.close();
  }
});
