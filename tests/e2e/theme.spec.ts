import { expect, test } from '@playwright/test';

// The in-app theme journey (UI-R5): the first paint honors the stored
// choice through the index.html boot script, the settings toggle applies
// instantly, the choice survives a reload, and 跟随系统 follows the OS
// live through the media-query listener. The locale is pinned so the
// radio labels match — and it is the app's stored form 'zh' (AppLocale),
// not the BCP 47 tag 'zh-CN' the store rejects. The keys are inlined as
// literals: the init script runs serialized in the page context, outside
// this module's scope. `labos-threejs.theme`/`labos-threejs.locale` are the same keys the
// boot script and the preferences store read
// (packages/views/src/shell/preferences.tsx).

test('the first paint renders the stored theme before the app boots', async ({
  page,
}) => {
  await page.addInitScript(
    ([theme, locale]) => {
      window.localStorage.setItem('labos-threejs.theme', theme!);
      window.localStorage.setItem('labos-threejs.locale', locale!);
    },
    ['dark', 'zh'],
  );
  await page.goto('/');
  // The class arrives from the inline boot script, so it is present as
  // soon as the document exists — no hydration, no waitFor.
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('switching the theme applies instantly and survives a reload', async ({
  page,
}) => {
  // Fully UI-driven (no storage seeding): addInitScript reruns on every
  // load, so a seeded choice would overwrite the click on reload. The
  // journey instead pins the locale by clicking the radio, persists an
  // explicit 亮色 against a dark OS, then proves 暗色 wins and persists.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/settings');
  await page.getByRole('radio', { name: '简体中文' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  // The OS flipped dark, but no explicit theme choice exists yet, so the
  // device still shows light only while `system` is selected.
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('radio', { name: '亮色' }).click();
  await expect(page.getByRole('radio', { name: '亮色' })).toBeChecked();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  const dark = page.getByRole('radio', { name: '暗色' });
  await dark.click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(dark).toBeChecked();
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('radio', { name: '暗色' })).toBeChecked();
});

test('跟随系统 follows the OS live, without a reload', async ({ page }) => {
  await page.addInitScript(
    ([theme, locale]) => {
      window.localStorage.setItem('labos-threejs.theme', theme!);
      window.localStorage.setItem('labos-threejs.locale', locale!);
    },
    ['system', 'zh'],
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});
