import { expect, test } from '@playwright/test';

// The dev/preview proxy forwards the backend namespaces (/api/v1 and
// /api/openapi.json) to the API and everything else to the SPA — a
// top-level document request for /api-keys must reach the app, not the
// API's 404 (UI-R4: the prefix proxy used to swallow it).
test('a top-level visit to /api-keys loads the app shell', async ({ page }) => {
  await page.goto('/api-keys');
  await expect(page.getByRole('main')).toBeAttached();
  await expect(page.locator('#app-sidebar')).toBeAttached();
});

test('a top-level visit to /settings loads the app shell', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('main')).toBeAttached();
});
