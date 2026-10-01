import { expect, test, type Page } from '@playwright/test';

// The site must keep working when it is published under a custom base
// (repository sub-path deployments). scripts/e2e-docs.mjs rebuilds the
// dist with DOCS_BASE=/ui16-custom-base/ and serves it there before this
// smoke runs; E2E_DOCS_URL therefore already carries the custom base, and
// every journey goes through a helper so it stays in the URL.
const site = new URL(process.env.E2E_DOCS_URL ?? 'http://127.0.0.1:0/');
const go = (page: Page, path = '/') =>
  page.goto(site.pathname.replace(/\/$/, '') + path);

test('the landing, its entries and the switcher survive a custom base', async ({
  page,
}) => {
  await go(page);
  await expect(page).toHaveTitle(/Lab Word/);
  await expect
    .poll(() =>
      page
        .locator('.lab-home img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1440);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Lab Word' }),
  ).toBeVisible();
  await expect(page.locator('.VPNavBarMenuLink')).toHaveCount(4);
  await page.locator('.VPNavBarMenuLink', { hasText: '文档' }).click();
  await expect(page).toHaveURL(/\/ui16-custom-base\/docs\/$/);
  await expect(
    page.getByRole('heading', { name: 'Lab Word 项目文档', level: 1 }),
  ).toBeVisible();
  await page.getByRole('banner').getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/ui16-custom-base\/en\/docs\/$/);
  await go(page, '/blog/');
  await expect(
    page.getByRole('heading', { level: 1, name: '博客 · 即将推出' }),
  ).toBeVisible();
  await page.getByRole('banner').getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/ui16-custom-base\/en\/blog\/$/);
});
