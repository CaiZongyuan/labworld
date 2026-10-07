import { expect, type Page } from '@playwright/test';

/** Existing workbench control: Entity selection needs its directory panel. */
export async function showObjectDirectory(page: Page) {
  const toggle = page.getByRole('button', {
    name: /^(打开对象目录|关闭对象目录|Open object directory|Close object directory)$/,
  });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false')
    await toggle.click();
}

export async function showRunHistory(page: Page) {
  const toggle = page.getByRole('button', {
    name: /^(打开运行历史|关闭运行历史|Open run history|Close run history)$/,
  });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false')
    await toggle.click();
}
