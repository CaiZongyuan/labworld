import {
  expect,
  test,
  request as playwrightRequest,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  showObjectDirectory,
  showEntityDetails,
  showEntityOperations,
} from './lab-desktop';

const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

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

test('WebGL unavailability keeps its recovery message clear of the canvas tools', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'WebGL2RenderingContext', {
      value: undefined,
      configurable: true,
    }),
  );
  if (!desktopMigration)
    await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`webgl-unavailable-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('world-browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Unavailable viewport');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Unavailable viewport', exact: true }),
  ).toBeVisible();
  const unavailable = page
    .getByRole('alert')
    .filter({ hasText: '此设备未提供 WebGL 2。' });
  await expect(unavailable).toBeVisible();
  const alertBounds = await unavailable.boundingBox();
  const toolBounds = await page.locator('.world-canvas-tools').boundingBox();
  expect(alertBounds!.y).toBeGreaterThanOrEqual(
    toolBounds!.y + toolBounds!.height,
  );
  await page.screenshot({
    path: `test-results/lab-foundation/t02-webgl-unavailable-${desktopMigration ? 'desktop' : 'mobile'}.png`,
    fullPage: true,
  });
});

test('a persistent Lab shares independent Entities, real multi-model picking and compressed resources with Members and an Agent', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`world-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('world-browser-test-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await page
    .getByLabel('GLB 文件')
    .setInputFiles('tests/fixtures/lab/cube-draco.glb');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '发布资产' })
    .click();
  await expect(page.getByText('cube-draco.glb', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Lab', exact: true }).click();
  await page.getByRole('button', { name: '创建 Lab' }).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('名称', { exact: true })
    .fill('Persistent identity lab');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Persistent identity lab', exact: true }),
  ).toBeVisible();
  for (const name of ['Cube A', 'Cube B']) {
    await page.getByRole('button', { name: '登记对象', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('定义版本').selectOption('model@1.0');
    await dialog
      .getByLabel('外观表示')
      .selectOption({ label: 'cube-draco · 1.0' });
    await dialog.getByLabel('名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '登记', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `选择 ${name}`, exact: true }),
    ).toBeVisible();
  }
  await page.getByRole('button', { name: '性能', exact: true }).click();
  const geometries = page
    .locator('.lab-perf-stats > div')
    .filter({ has: page.getByText('Geometries', { exact: true }) })
    .locator('dd');
  const triangles = page
    .locator('.lab-perf-stats > div')
    .filter({ has: page.getByText('三角形', { exact: true }) })
    .locator('dd');
  await expect
    .poll(async () => Number((await triangles.innerText()).replaceAll(',', '')))
    .toBeGreaterThanOrEqual(24);
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await expectCanvasPixels(page);
  await page.getByRole('button', { name: '选择 Cube A', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  await showEntityDetails(page);
  const labId = await inspector
    .locator('dt')
    .filter({ hasText: /^Lab$/ })
    .locator('+ dd')
    .innerText();
  const firstId = await inspector
    .locator('dt')
    .filter({ hasText: /^Entity$/ })
    .locator('+ dd')
    .innerText();
  await page.getByRole('button', { name: '选择 Cube B', exact: true }).click();
  await showEntityDetails(page);
  const secondId = await inspector
    .locator('dt')
    .filter({ hasText: /^Entity$/ })
    .locator('+ dd')
    .innerText();
  expect(firstId).not.toBe(secondId);
  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).toBeTruthy();
  const picked = new Set<string>();
  for (let y = 0.35; y <= 0.7 && picked.size < 2; y += 0.07)
    for (let x = 0.3; x <= 0.7 && picked.size < 2; x += 0.07) {
      await canvas.click({
        position: { x: bounds!.width * x, y: bounds!.height * y },
      });
      if (!(await inspector.isVisible())) continue;
      await showEntityDetails(page);
      if (
        (await inspector
          .locator('dt')
          .filter({ hasText: /^Entity$/ })
          .count()) === 0
      )
        continue;
      const id = await inspector
        .locator('dt')
        .filter({ hasText: /^Entity$/ })
        .locator('+ dd')
        .innerText();
      if (id === firstId || id === secondId) {
        const name = id === firstId ? 'Cube A' : 'Cube B';
        await expect(
          page.getByRole('button', { name: `选择 ${name}`, exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
        picked.add(id);
      }
    }
  expect(picked.size).toBe(2);
  await page
    .getByRole('checkbox', { name: '多选 Cube A', exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: '多选 Cube B', exact: true })
    .check();
  await expect(page.locator('.world-inspector > header > span')).toHaveText(
    '2',
  );
  await page.getByRole('button', { name: '选择 Cube A', exact: true }).click();
  await showEntityDetails(page);
  await page
    .getByRole('button', { name: '新增同一对象表示', exact: true })
    .click();
  await expect(inspector.locator('.world-node')).toHaveCount(2);
  await expect(page.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect
    .poll(async () => Number((await triangles.innerText()).replaceAll(',', '')))
    .toBeGreaterThanOrEqual(36);
  const baseline = Number(await geometries.innerText());
  await page.screenshot({
    path: 'test-results/lab-foundation/t02-world-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: '配置对象', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('标识', { exact: true }).fill('north');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(inspector.getByText('north', { exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const keyResponse = await page.request.post('/api/v1/api-keys', {
    headers: {
      origin: process.env.E2E_WEB_URL!,
      'x-csrf-token': session.csrf_token,
    },
    data: {
      name: 'World tutorial Agent',
      scopes: ['lab:full'],
      expires_in_days: 1,
    },
  });
  expect(keyResponse.status()).toBe(201);
  const key = await keyResponse.json();
  const tutorial = JSON.parse(
    execFileSync('node', ['examples/lab/register-world.mjs'], {
      env: {
        ...process.env,
        LAB_API_BASE: process.env.E2E_API_URL,
        LAB_API_KEY: key.secret,
        LAB_ID: labId,
      },
      encoding: 'utf8',
    }),
  );
  expect(tutorial.entity_ids).toHaveLength(2);
  await page.reload();
  await page.getByLabel('打开 Lab').selectOption(labId);
  await showObjectDirectory(page);
  await expect(
    page.getByRole('button', { name: '选择 Robot A', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '选择 Robot A', exact: true }).click();
  await showEntityDetails(page);
  await expect(
    inspector.getByText(tutorial.entity_ids[0], { exact: true }),
  ).toBeVisible();
  await showEntityOperations(page);
  await expect(
    inspector.getByText('未知 · 无观测', { exact: true }),
  ).toBeVisible();
  await showEntityDetails(page);
  await expect(
    inspector.getByText('robot.pick', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await page
    .getByRole('button', { name: '移除 cube-draco', exact: true })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '移除', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('资产已被引用');
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  const second = await browser.newContext({
    locale: 'zh-CN',
    baseURL: process.env.E2E_WEB_URL,
  });
  const other = await second.newPage();
  other.on('pageerror', (error) => errors.push(error.name));
  await other.goto('/register');
  await other
    .getByLabel('邮箱', { exact: true })
    .fill(`world-other-${Date.now()}@example.test`);
  await other
    .getByLabel('密码', { exact: true })
    .fill('world-browser-test-password');
  await other.getByRole('button', { name: '创建账号' }).click();
  await other.getByLabel('打开 Lab').selectOption(labId);
  await showObjectDirectory(other);
  await other.getByRole('button', { name: '选择 Cube A', exact: true }).click();
  const otherInspector = other.getByRole('complementary', { name: '对象信息' });
  await showEntityDetails(other);
  await expect(
    otherInspector.getByText(firstId, { exact: true }),
  ).toBeVisible();
  await expect(
    otherInspector.getByText('north', { exact: true }),
  ).toBeVisible();
  await expect(otherInspector.locator('.world-node')).toHaveCount(2);
  await expectCanvasPixels(other);
  await expect(other.locator('.world-render-error')).toHaveCount(0);
  await other.getByRole('button', { name: '性能', exact: true }).click();
  await other
    .getByRole('checkbox', { name: '多选 Cube A', exact: true })
    .uncheck();
  const otherGeometries = other
    .locator('.lab-perf-stats > div')
    .filter({ has: other.getByText('Geometries', { exact: true }) })
    .locator('dd');
  await expect(other.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect
    .poll(async () => Number(await otherGeometries.innerText()))
    .toBeGreaterThan(baseline);
  const loadedCount = await otherGeometries.innerText();
  expect(Number(loadedCount)).toBeGreaterThan(baseline);
  await other.getByRole('button', { name: '创建 Lab' }).click();
  await other
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Empty resource lab');
  await other
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(
    other.getByRole('heading', { name: 'Empty resource lab', exact: true }),
  ).toBeVisible();
  const emptyId = await other.getByLabel('打开 Lab').inputValue();
  await other.getByRole('button', { name: '性能', exact: true }).click();
  await expect
    .poll(async () => Number(await otherGeometries.innerText()))
    .toBeLessThan(Number(loadedCount));
  const emptyCount = await otherGeometries.innerText();
  for (let i = 0; i < 3; i++) {
    await other.getByLabel('打开 Lab').selectOption(labId);
    await expect(other.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await other.getByRole('button', { name: '性能', exact: true }).click();
    await expect
      .poll(async () => Number(await otherGeometries.innerText()))
      .toBeGreaterThan(baseline);
    await expect
      .poll(async () => Number(await otherGeometries.innerText()))
      .toBeLessThanOrEqual(Number(loadedCount));
    await other.getByLabel('打开 Lab').selectOption(emptyId);
    await other.getByRole('button', { name: '性能', exact: true }).click();
    await expect(otherGeometries).toHaveText(emptyCount);
  }
  await other.getByLabel('打开 Lab').selectOption(labId);
  await showObjectDirectory(other);
  await other.getByRole('button', { name: '选择 Cube A', exact: true }).click();
  if (!desktopMigration)
    await other.setViewportSize({ width: 390, height: 844 });
  await other.getByRole('button', { name: 'English', exact: true }).click();
  await other.evaluate(() =>
    localStorage.setItem('labos-threejs.theme', 'dark'),
  );
  await other.reload();
  await other.getByLabel('Open Lab').selectOption(labId);
  await showObjectDirectory(other);
  await other
    .getByRole('button', { name: 'Select Cube A', exact: true })
    .click();
  await expectCanvasPixels(other);
  expect(
    await other.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await other.screenshot({
    path: `test-results/lab-foundation/t02-world-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
    fullPage: true,
  });
  await other
    .getByRole('complementary', { name: 'Object info' })
    .getByText(firstId, { exact: true })
    .scrollIntoViewIfNeeded();
  await other.screenshot({
    path: `test-results/lab-foundation/t02-inspector-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
    fullPage: true,
  });
  await second.close();
  expect(errors).toEqual([]);
});

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
  await page.goto('/lab/asset');
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
  await page
    .getByRole('button', { name: '在 Lab 中打开 cube', exact: true })
    .click();
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
  await expect(page).toHaveURL(/\/lab$/);
  await page.goto('/lab/asset');
  await expect(page.locator('.lab-page')).toHaveAttribute('aria-busy', 'false');
  for (const codec of ['draco', 'meshopt', 'basis']) {
    await page
      .getByLabel('GLB 文件')
      .setInputFiles(`tests/fixtures/lab/cube-${codec}.glb`);
    // Verification already has a 40-second request budget; wait for the rendered model.
    await expect(page.locator('.lab-asset-copy')).toContainText(
      `cube-${codec}.glb`,
      { timeout: 45000 },
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
  if (!desktopMigration)
    await page.setViewportSize({ width: 390, height: 844 });
  await expectCanvasPixels(page);
  await page.screenshot({
    path: `test-results/lab-foundation/t01-viewer-${desktopMigration ? 'desktop' : 'mobile'}.png`,
    fullPage: true,
  });
  if (!desktopMigration)
    await page
      .getByRole('button', { name: '打开导航菜单', exact: true })
      .click();
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  await expect(page.getByText('冷冻离心机', { exact: true })).toBeVisible();
  for (const width of desktopMigration ? [1440] : [390, 320]) {
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
