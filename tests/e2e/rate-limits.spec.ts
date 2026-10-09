import { expect, test } from '@playwright/test';

// The device language follows the browser in the product, so journeys that
// assert Chinese pin the locale explicitly instead of relying on the
// runner default (see password-reset.spec.ts).
test.use({ locale: 'zh-CN' });

test('a browser waits after a real authentication limit and then signs in', async ({
  page,
}) => {
  const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECS ?? 60);
  const capacity = Number(process.env.RATE_LIMIT_AUTHENTICATION ?? 60);
  test.setTimeout((windowSeconds + 45) * 1000);
  await page.goto('/login');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(process.env.E2E_OWNER_EMAIL!);
  await page
    .getByLabel('密码', { exact: true })
    .fill(process.env.E2E_OWNER_PASSWORD!);
  // Real malformed HTTP attempts consume the same policy without wasting password-hash work.
  await expect
    .poll(
      async () => {
        for (let attempt = 0; attempt <= capacity; attempt++) {
          const response = await page.request.post('/api/v1/auth/login', {
            headers: { origin: process.env.E2E_WEB_URL! },
            data: {},
          });
          if (response.status() === 429)
            return Number(response.headers()['retry-after']);
          expect(response.status()).toBe(400);
        }
        return 0;
      },
      {
        timeout: Math.max(5000, windowSeconds * 1000 + 3000),
        intervals: [100, 250, 500],
      },
    )
    .toBeGreaterThanOrEqual(Math.min(2, windowSeconds));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请求过于频繁');
  await expect(page.getByRole('button', { name: /请等待/ })).toBeDisabled();
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(
    process.env.E2E_OWNER_EMAIL!,
  );
  const submit = page.getByRole('button', { name: '登录', exact: true });
  await expect(submit).toBeEnabled({ timeout: (windowSeconds + 3) * 1000 });
  await expect(page).toHaveURL(/\/login$/);
  await submit.click();
  // A successful sign-in lands on the documents entry.
  await expect(page.getByRole('heading', { name: '我的文档' })).toBeVisible();
});
