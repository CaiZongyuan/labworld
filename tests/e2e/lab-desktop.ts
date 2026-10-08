import { expect, type Page } from '@playwright/test';

/** Existing workbench control: Entity selection needs its directory panel. */
export async function showObjectDirectory(page: Page) {
  const toggle = page.locator('.lab-toolbar').getByRole('button', {
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

async function closeNarrowDirectory(page: Page) {
  if ((page.viewportSize()?.width ?? 0) <= 560) {
    const directory = page.locator('.lab-toolbar').getByRole('button', {
      name: /^(打开对象目录|关闭对象目录|Open object directory|Close object directory)$/,
    });
    if ((await directory.getAttribute('aria-expanded')) === 'true')
      await directory.click();
  }
}

/** Use the ordinary shared detail tabs before reading identities or operating. */
export async function showEntityDetails(page: Page) {
  await closeNarrowDirectory(page);
  const inspector = page.getByRole('complementary', {
    name: /^(对象信息|Object info)$/,
  });
  await inspector.getByRole('tab', { name: /^(详情|Details)$/ }).click();
  return inspector.getByRole('tabpanel', { name: /^(详情|Details)$/ });
}

export async function showEntityOperations(page: Page) {
  const runtime = page.getByRole('tab', { name: /^(运行查看|Runtime)$/ });
  if ((await runtime.getAttribute('aria-selected')) === 'false')
    await runtime.click();
  await closeNarrowDirectory(page);
  const inspector = page.getByRole('complementary', {
    name: /^(对象信息|Object info)$/,
  });
  await inspector.getByRole('tab', { name: /^(操作|Operations)$/ }).click();
  return inspector.getByRole('tabpanel', { name: /^(操作|Operations)$/ });
}
