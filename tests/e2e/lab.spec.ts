import {
  expect,
  test,
  request as playwrightRequest,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test.use({ locale: 'zh-CN' });

async function expectCanvasPixels(page: Page) {
  const png = await page.locator('canvas').screenshot();
  const colors = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (
      let y = Math.floor(canvas.height * 0.3);
      y < canvas.height * 0.7;
      y += 5
    )
      for (
        let x = Math.floor(canvas.width * 0.3);
        x < canvas.width * 0.7;
        x += 5
      ) {
        const offset = (y * canvas.width + x) * 4;
        colors.add(
          `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`,
        );
      }
    return colors.size;
  }, png.toString('base64'));
  expect(colors).toBeGreaterThan(30);
}

test('members and an Agent share persistent GLB assets across browser contexts and recover from a failed model', async ({
  page,
  browser,
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
  await expect(page.getByText('冷冻离心机', { exact: true })).toBeVisible();
  await page.screenshot({
    path: 'test-results/lab-foundation/t01-assets-desktop.png',
    fullPage: true,
  });
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const keyResponse = await page.request.post('/api/v1/api-keys', {
    headers: {
      origin: process.env.E2E_WEB_URL!,
      'x-csrf-token': session.csrf_token,
    },
    data: {
      name: 'Browser journey Agent',
      scopes: ['lab:full'],
      expires_in_days: 1,
    },
  });
  expect(keyResponse.status()).toBe(201);
  const key = await keyResponse.json();
  const importEnv = {
    ...process.env,
    LAB_API_KEY: key.secret,
    LAB_API_BASE: process.env.E2E_API_URL,
    LAB_UPLOAD_KEY: 'tutorial-agent-cube',
    LAB_ASSET_NAME: 'Agent tutorial cube',
  };
  const imported = JSON.parse(
    execFileSync(
      'node',
      ['examples/lab/import-asset.mjs', 'tests/fixtures/lab/cube.glb'],
      { env: importEnv, encoding: 'utf8' },
    ),
  );
  const retried = JSON.parse(
    execFileSync(
      'node',
      ['examples/lab/import-asset.mjs', 'tests/fixtures/lab/cube.glb'],
      { env: importEnv, encoding: 'utf8' },
    ),
  );
  expect(retried.id).toBe(imported.id);
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL,
  });
  const listing = await agent.get('/api/v1/lab/assets', {
    headers: { authorization: `Bearer ${key.secret}` },
  });
  expect(listing.status()).toBe(200);
  const asset = (await listing.json()).data.find(
    (entry: { name: string }) => entry.name === 'cube',
  );
  expect(asset.representation.file_id).toBeTruthy();
  const read = await agent.get(`/api/v1/lab/assets/${asset.id}`, {
    headers: { authorization: `Bearer ${key.secret}` },
  });
  expect(read.status()).toBe(200);
  expect((await read.json()).id).toBe(asset.id);
  await agent.dispose();
  const second = await browser.newContext({
    locale: 'zh-CN',
    baseURL: process.env.E2E_WEB_URL,
  });
  const other = await second.newPage();
  await other.goto('/register');
  await other
    .getByLabel('邮箱', { exact: true })
    .fill(`lab-other-${Date.now()}@example.test`);
  await other
    .getByLabel('密码', { exact: true })
    .fill('lab-browser-test-password');
  await other.getByRole('button', { name: '创建账号' }).click();
  await expect(other).toHaveURL(/\/lab$/);
  await other.getByRole('link', { name: '资产库', exact: true }).click();
  await other
    .getByRole('button', { name: '在 Lab 中打开 cube', exact: true })
    .click();
  await expect(other.locator('.lab-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(other.locator('.lab-asset-copy')).toContainText('cube.glb');
  await expectCanvasPixels(other);
  await other.reload();
  await other.getByRole('link', { name: '资产库', exact: true }).click();
  await expect(
    other.getByRole('button', { name: '在 Lab 中打开 cube', exact: true }),
  ).toBeVisible();
  await second.close();
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

test('persistent Draco, Meshopt and Basis models render at their original scale on desktop and mobile', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`compressed-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('lab-browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.locator('.lab-page')).toHaveAttribute('aria-busy', 'false');
  for (const codec of ['draco', 'meshopt', 'basis']) {
    await page
      .getByLabel('GLB 文件')
      .setInputFiles(`tests/fixtures/lab/cube-${codec}.glb`);
    await expect(page.locator('.lab-asset-copy')).toContainText(
      `cube-${codec}.glb`,
    );
    await expect(page.locator('.lab-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expectCanvasPixels(page);
    await expect(page.locator('.lab-dimensions strong')).toHaveText([
      '1.000',
      '1.000',
      '1.000',
    ]);
    await page.screenshot({
      path: `test-results/lab-foundation/t01-${codec}-desktop.png`,
    });
  }
  const before = await page.locator('canvas').screenshot();
  await page.getByRole('button', { name: '自动旋转', exact: true }).click();
  await expect
    .poll(async () =>
      (await page.locator('canvas').screenshot()).equals(before),
    )
    .toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectCanvasPixels(page);
  await page.screenshot({
    path: 'test-results/lab-foundation/t01-viewer-mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await expect(page.getByText('冷冻离心机', { exact: true })).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/lab-foundation/t01-assets-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(
    page.getByText('Refrigerated centrifuge', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/lab-foundation/t01-assets-dark-english-320.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
