import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ locale: 'zh-CN' });

test('a signed-in member imports GLB assets, opens them from the catalog and recovers from a failed model', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`lab-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('lab-browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await expect(
    page.getByRole('heading', { name: '资产查看', exact: true }),
  ).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('.lab-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.lab-loading')).toHaveCount(0);
  await expect(page.locator('.lab-asset-copy')).toContainText('工业显微镜');

  await page
    .getByLabel('GLB 文件')
    .setInputFiles('tests/fixtures/lab/cube.glb');
  await expect(page.locator('.lab-asset-copy')).toContainText('cube.glb');
  await expect(page.locator('.lab-page')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.lab-loading')).toHaveCount(0);
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await expect(page.getByText('cube.glb', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索资产' }).fill('cube');
  await expect(page.getByText('工业显微镜', { exact: true })).toHaveCount(0);
  await page
    .getByRole('button', { name: '在 Lab 中打开 cube', exact: true })
    .click();
  await expect(page.locator('.lab-asset-copy')).toContainText('cube.glb');
  await expect(page.locator('.lab-page')).toHaveAttribute('aria-busy', 'false');

  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 123 } }] }],
      accessors: [],
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const broken = Buffer.alloc(20 + jsonLength, 0x20);
  broken.writeUInt32LE(0x46546c67, 0);
  broken.writeUInt32LE(2, 4);
  broken.writeUInt32LE(broken.length, 8);
  broken.writeUInt32LE(jsonLength, 12);
  broken.writeUInt32LE(0x4e4f534a, 16);
  json.copy(broken, 20);
  await page.getByLabel('GLB 文件').setInputFiles({
    name: 'invalid-accessor.glb',
    mimeType: 'model/gltf-binary',
    buffer: broken,
  });
  await expect(
    page.getByRole('alert').filter({ hasText: '导入未完成' }),
  ).toBeVisible();
  await expect(page.locator('.lab-asset-copy')).toContainText('cube.glb');
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await page.getByRole('link', { name: 'Lab', exact: true }).click();
  await expect(page.locator('.lab-asset-copy')).toContainText('cube.glb');

  const bytes = readFileSync('tests/fixtures/lab/mixed.glb');
  await page.getByLabel('GLB 文件').setInputFiles({
    name: 'mixed.glb',
    buffer: bytes,
    mimeType: 'model/gltf-binary',
  });
  await expect(page.locator('.lab-asset-copy')).toContainText('mixed.glb');
  await expect(page.locator('.lab-loading')).toHaveCount(0);
  await page.getByRole('button', { name: '恢复示例', exact: true }).click();
  await expect(page.locator('.lab-asset-copy')).toContainText('工业显微镜');
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await page.getByRole('button', { name: '移除 mixed', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '移除', exact: true })
    .click();
  await expect(page.getByText('mixed.glb', { exact: true })).toHaveCount(0);
});
