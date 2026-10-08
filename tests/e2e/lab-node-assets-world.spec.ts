import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus || !process.env.LAB_NODE_EVIDENCE)
    return;
  writeFileSync(
    join(process.env.LAB_NODE_EVIDENCE, 'desktop-failure-location.json'),
    JSON.stringify(
      {
        status: info.status,
        locations: info.errors.flatMap(
          (error) =>
            error.stack?.match(/lab-node-assets-world\.spec\.ts:\d+:\d+/g) ??
            [],
        ),
        path: new URL(page.url()).pathname,
      },
      null,
      2,
    ),
  );
  if (['/lab', '/assets', '/lab/asset'].includes(new URL(page.url()).pathname))
    await page.screenshot({
      path: join(process.env.LAB_NODE_EVIDENCE, 'desktop-failure.png'),
    });
});
async function register(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill('node-browser-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/lab$/);
}
async function object(
  page: Page,
  name: string,
  definition: string,
  appearance = '',
) {
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
  if (appearance)
    await dialog.getByLabel('外观表示').selectOption({ label: appearance });
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `选择 ${name}`, exact: true }),
  ).toBeVisible();
}
test('Node assets and World preserve desktop space, selection, deep links and conflict drafts in the existing Web consumer', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  const checkpoint = (stage: string) => {
    if (process.env.LAB_NODE_EVIDENCE)
      writeFileSync(
        join(process.env.LAB_NODE_EVIDENCE, 'desktop-stage.json'),
        JSON.stringify({ stage, at: new Date().toISOString() }),
      );
  };
  checkpoint('member-register');
  await register(page, `node-world-${Date.now()}@example.test`);
  checkpoint('assets');
  await page.goto('/assets');
  await page.getByLabel('GLB 文件').setInputFiles({
    name: 'node-cube.glb',
    mimeType: 'model/gltf-binary',
    buffer: readFileSync('tests/fixtures/lab/cube.glb'),
  });
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Node cube');
  await page.getByRole('button', { name: '发布资产', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '在 Lab 中打开 Node cube', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '在 Lab 中打开 Node cube', exact: true })
    .click();
  await expect(page).toHaveURL(/\/lab\/asset/);
  await expect(page.locator('.lab-asset-copy')).toContainText('node-cube.glb');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '资产查看', exact: true }),
  ).toBeVisible();
  checkpoint('assets');
  await page.goto('/assets');
  await page
    .getByRole('button', { name: '在 Lab 中打开 Node cube', exact: true })
    .click();
  await expect(page.locator('.lab-asset-copy')).toContainText('node-cube.glb');
  await page.goto('/lab');
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('Node desktop Lab');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Node desktop Lab', exact: true }),
  ).toBeVisible();
  checkpoint('register-world');
  await object(page, 'Robot landmark', 'robot');
  await object(page, 'Persisted cube', 'model', 'Node cube · 1.0');
  await page
    .getByRole('button', { name: '选择 Robot landmark', exact: true })
    .click();
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  const labId = await inspector
    .locator('dt')
    .filter({ hasText: /^Lab$/ })
    .locator('+ dd')
    .innerText();
  const entityId = await inspector
    .locator('dt')
    .filter({ hasText: /^Entity$/ })
    .locator('+ dd')
    .innerText();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('lab') === labId &&
      url.searchParams.get('entity') === entityId,
  );
  await page.reload();
  await expect(
    inspector
      .locator('dt')
      .filter({ hasText: /^Entity$/ })
      .locator('+ dd'),
  ).toHaveText(entityId);
  checkpoint('visible-world-pixels');
  await expect(page.locator('canvas')).toBeVisible();
  await expect
    .poll(
      async () => {
        const png = await page.locator('canvas').screenshot(),
          rect = (await page.locator('canvas').boundingBox())!;
        return page.evaluate(
          async ({ encoded, rect }) => {
            const picture = new Image();
            picture.src = 'data:image/png;base64,' + encoded;
            await picture.decode();
            const canvas = document.createElement('canvas');
            canvas.width = picture.width;
            canvas.height = picture.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(picture, 0, 0);
            const pixels = context.getImageData(
              0,
              0,
              picture.width,
              picture.height,
            ).data;
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (
                pixels[i + 1] > pixels[i] * 1.2 &&
                pixels[i + 2] > pixels[i] * 1.2 &&
                pixels[i + 2] > 45
              ) {
                const x = (i / 4) % picture.width,
                  y = Math.floor(i / 4 / picture.width);
                if (
                  document.elementFromPoint(rect.x + x, rect.y + y)?.tagName ===
                  'CANVAS'
                )
                  count++;
                if (count >= 500) break;
              }
            return count;
          },
          { encoded: png.toString('base64'), rect },
        );
      },
      { timeout: 30000 },
    )
    .toBeGreaterThan(100);
  const secondContext = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    }),
    second = await secondContext.newPage();
  try {
    checkpoint('peer-register');
    await register(second, `node-peer-${Date.now()}@example.test`);
    await second.getByLabel('打开 Lab', { exact: true }).selectOption(labId);
    await expect(
      second.getByRole('heading', { name: 'Node desktop Lab', exact: true }),
    ).toBeVisible();
    for (const current of [page, second]) {
      const directory = current.getByRole('button', {
        name: '打开对象目录',
        exact: true,
      });
      if ((await directory.getAttribute('aria-expanded')) === 'false')
        await directory.click();
      await current
        .getByRole('button', { name: '选择 Robot landmark', exact: true })
        .click({ timeout: 10000 });
      await current.getByRole('tab', { name: '编辑布局', exact: true }).click();
    }
    checkpoint('first-coordinate');
    await inspector
      .getByLabel('X (m)', { exact: true })
      .fill('2.25', { timeout: 10000 });
    await second
      .getByRole('complementary', { name: '对象信息' })
      .getByLabel('X (m)', { exact: true })
      .fill('3', { timeout: 10000 });
    checkpoint('peer-save');
    await second.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect(
      second.getByRole('status', { name: '布局保存状态' }),
    ).toHaveText('已保存');
    checkpoint('conflict-save');
    await page.getByRole('button', { name: /^(保存布局|重试保存)$/ }).click();
    await expect(
      page.getByText('布局已改变，草稿已保留', { exact: true }),
    ).toBeVisible();
    await expect(inspector.getByLabel('X (m)', { exact: true })).toHaveValue(
      '2.25',
    );
    await page
      .getByRole('button', { name: '重新载入并保留草稿', exact: true })
      .click();
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
      '已保存',
    );
    const world = await (
      await page.request.get(`/api/v1/lab/labs/${labId}/world`)
    ).json();
    expect(
      world.nodes.find(
        (node: { entity_id: string }) =>
          node.entity_id ===
          world.entities.find(
            (entity: { name: string }) => entity.name === 'Robot landmark',
          ).id,
      ).placement.position[0],
    ).toBe(2.25);
    expect(world.assets).toHaveLength(1);
    expect(errors).toEqual([]);
    if (process.env.LAB_NODE_EVIDENCE) {
      await page.screenshot({
        path: join(process.env.LAB_NODE_EVIDENCE, 'desktop-world.png'),
      });
      writeFileSync(
        join(process.env.LAB_NODE_EVIDENCE, 'desktop-acceptance.json'),
        JSON.stringify(
          {
            viewport: { width: 1440, height: 1000 },
            assetDeepLink: true,
            worldDeepLink: { labId, entityId, refresh: true },
            exteriorRobotPixelsGreaterThan: 100,
            sharedLab: labId,
            conflictDraft: 2.25,
            selection: 'Robot landmark',
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await secondContext.close();
  }
});
