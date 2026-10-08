import { showObjectDirectory, showEntityOperations } from './lab-desktop';
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SceneNode } from '../../packages/contracts/src/generated/types.gen';
const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });

async function registerObject(page: Page, definition: string, name: string) {
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/v1\/lab\/labs\/[^/]+\/entities$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const entity = await response.json();
  await expect(
    page.getByRole('button', { name: `选择 ${name}`, exact: true }),
  ).toBeVisible();
  return entity.id as string;
}
async function redHandle(page: Page) {
  const png = await page.locator('canvas').screenshot();
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < pixels.length; i += 4)
      if (
        pixels[i] > 180 &&
        pixels[i] > pixels[i + 1] * 1.8 &&
        pixels[i] > pixels[i + 2] * 1.8
      ) {
        points.push({
          x: (i / 4) % image.width,
          y: Math.floor(i / 4 / image.width),
        });
      }
    return {
      ...(points[Math.floor(points.length * 0.65)] ?? { x: 0, y: 0 }),
      count: points.length,
    };
  }, png.toString('base64'));
}

test('real pointer transforms edit Placement while manual location stays unchanged', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`layout-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('layout-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Layout lab');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Layout lab', exact: true }),
  ).toBeVisible();
  const benchId = await registerObject(page, 'bench', 'Bench');
  const beakerId = await registerObject(page, 'labware', 'Beaker');
  await page.getByRole('tab', { name: '编辑布局', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  await expect(
    inspector
      .locator('dt')
      .filter({ hasText: /^Entity$/ })
      .locator('+ dd'),
  ).toHaveText(beakerId);
  const lab = await inspector
    .locator('dt')
    .filter({ hasText: /^Lab$/ })
    .locator('+ dd')
    .innerText();
  const beforeWorld = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  await inspector.getByLabel('关系对象').selectOption(benchId);
  await inspector
    .getByRole('button', { name: '登记关系', exact: true })
    .click();
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
    '已保存',
  );
  const registered = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  const ownedBeakerNodes = registered.nodes.filter(
    (node: SceneNode) => node.entity_id === beakerId,
  );
  expect(ownedBeakerNodes).toHaveLength(1);
  const beakerNodeId = ownedBeakerNodes[0].id;
  const beakerNode = (snapshot: { nodes: SceneNode[] }) => {
    const node = snapshot.nodes.find((entry) => entry.id === beakerNodeId);
    expect(node?.entity_id).toBe(beakerId);
    return node!;
  };
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await expect
    .poll(async () => (await redHandle(page)).count)
    .toBeGreaterThan(10);
  const point = await redHandle(page),
    bounds = (await page.locator('canvas').boundingBox())!;
  const before = Number(
    await inspector.getByLabel('X (m)', { exact: true }).inputValue(),
  );
  await page.mouse.move(bounds.x + point.x, bounds.y + point.y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + point.x + 60, bounds.y + point.y, {
    steps: 12,
  });
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await inspector.getByLabel('X (m)', { exact: true }).inputValue()),
    )
    .not.toBe(before);
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
    '已保存',
  );
  const moved = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  expect(moved.relationships).toEqual(registered.relationships);
  expect(beakerNode(moved).placement.position).not.toEqual(
    beakerNode(registered).placement.position,
  );
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  for (const [mode, field] of [
    ['旋转', 'Rx (rad)'],
    ['缩放', 'Sx'],
  ]) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect
      .poll(async () => (await redHandle(page)).count)
      .toBeGreaterThan(10);
    const handle = await redHandle(page),
      rect = (await page.locator('canvas').boundingBox())!;
    const original = Number(
      await inspector.getByLabel(field, { exact: true }).inputValue(),
    );
    await page.mouse.move(rect.x + handle.x, rect.y + handle.y);
    await page.mouse.down();
    await page.mouse.move(rect.x + handle.x + 35, rect.y + handle.y - 35, {
      steps: 12,
    });
    await page.mouse.up();
    await expect
      .poll(async () =>
        Number(await inspector.getByLabel(field, { exact: true }).inputValue()),
      )
      .not.toBe(original);
    await page.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
      '已保存',
    );
  }
  const transformed = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  expect(transformed.relationships).toEqual(registered.relationships);
  expect(beakerNode(transformed).placement.rotation).not.toEqual(
    beakerNode(moved).placement.rotation,
  );
  expect(beakerNode(transformed).placement.scale).not.toEqual(
    beakerNode(moved).placement.scale,
  );
  await inspector
    .getByRole('button', { name: '复制为独立实例', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '选择 Beaker 副本', exact: true }),
  ).toBeVisible();
  const copied = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  const originalId = beforeWorld.entities.find(
    (entity: { name: string }) => entity.name === 'Beaker',
  ).id;
  expect(originalId).toBe(beakerId);
  const copiedId = copied.entities.find(
    (entity: { name: string }) => entity.name === 'Beaker 副本',
  ).id;
  expect(copiedId).not.toBe(originalId);
  await inspector
    .getByRole('button', { name: '新增同一对象表示', exact: true })
    .click();
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
    '已保存',
  );
  let snapshot = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  expect(
    snapshot.nodes.filter(
      (node: { entity_id: string }) => node.entity_id === copiedId,
    ),
  ).toHaveLength(2);
  expect(snapshot.entities).toHaveLength(3);
  await inspector
    .getByRole('button', { name: '移除节点', exact: true })
    .last()
    .click();
  await inspector
    .getByRole('button', { name: '移除节点', exact: true })
    .click();
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
    '已保存',
  );
  await page
    .getByRole('checkbox', { name: '仅未放置对象', exact: true })
    .check();
  await expect(
    page.getByRole('button', { name: '选择 Beaker 副本', exact: true }),
  ).toBeVisible();
  await inspector
    .getByRole('button', { name: '新增同一对象表示', exact: true })
    .click();
  await page.getByRole('button', { name: '保存布局', exact: true }).click();
  await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
    '已保存',
  );
  await page
    .getByRole('checkbox', { name: '仅未放置对象', exact: true })
    .uncheck();
  const otherContext = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const other = await otherContext.newPage();
    other.on('pageerror', (error) => errors.push(error.name));
    await other.goto(`${process.env.E2E_WEB_URL}/register`);
    await other
      .getByLabel('邮箱', { exact: true })
      .fill(`layout-other-${Date.now()}@example.test`);
    await other
      .getByLabel('密码', { exact: true })
      .fill('layout-other-password');
    await other.getByRole('button', { name: '创建账号' }).click();
    await expect(other).toHaveURL(/\/lab$/);
    await other
      .getByRole('combobox', { name: '打开 Lab', exact: true })
      .selectOption(lab);
    await showObjectDirectory(other);
    await other
      .getByRole('button', { name: '选择 Bench', exact: true })
      .click();
    await other.getByRole('tab', { name: '编辑布局', exact: true }).click();
    await other.getByLabel('X (m)', { exact: true }).fill('5');
    await page
      .getByRole('button', { name: '选择 Beaker', exact: true })
      .click();
    await inspector.getByLabel('X (m)', { exact: true }).fill('3');
    await other.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect(
      other.getByRole('status', { name: '布局保存状态' }),
    ).toHaveText('已保存');
    const mainSave = page.getByRole('button', {
      name: /^(保存布局|重试保存)$/,
    });
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        'layout-main-save-action.json',
      ),
      JSON.stringify({
        label: await mainSave.getAttribute('aria-label'),
        rawX: await inspector.getByLabel('X (m)', { exact: true }).inputValue(),
      }),
    );
    await mainSave.click();
    await expect(
      page.getByText('布局已改变，草稿已保留', { exact: true }),
    ).toBeVisible();
    await expect(inspector.getByLabel('X (m)', { exact: true })).toHaveValue(
      '3',
    );
    await page.screenshot({
      path: 'test-results/lab-foundation/t04-layout-conflict.png',
      fullPage: true,
    });
    await page
      .getByRole('button', { name: '重新载入并保留草稿', exact: true })
      .click();
    await expect(inspector.getByLabel('X (m)', { exact: true })).toHaveValue(
      '3',
    );
    await page.getByRole('button', { name: '重试保存', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
      '已保存',
    );
    await other.reload();
    await showObjectDirectory(other);
    await other
      .getByRole('button', { name: '选择 Beaker', exact: true })
      .click();
    await other.getByRole('tab', { name: '编辑布局', exact: true }).click();
    await expect(other.getByLabel('X (m)', { exact: true })).toHaveValue('3');
    await other
      .getByRole('button', { name: '选择 Bench', exact: true })
      .click();
    await expect(other.getByLabel('X (m)', { exact: true })).toHaveValue('5');
  } finally {
    await otherContext.close();
  }
  await registerObject(page, 'light', 'Editing light');
  await showEntityOperations(page);
  await inspector
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await expect(
    inspector.getByRole('switch', { name: '电源', exact: true }),
  ).toBeEnabled();
  await page.getByRole('tab', { name: '编辑布局', exact: true }).click();
  await inspector.getByLabel('X (m)', { exact: true }).fill('7');
  await showEntityOperations(page);
  await inspector.getByRole('switch', { name: '电源', exact: true }).click();
  await expect(inspector.getByText('执行完成', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '编辑布局', exact: true }).click();
  await expect(inspector.getByLabel('X (m)', { exact: true })).toHaveValue('7');
  await inspector.getByLabel('X (m)', { exact: true }).focus();
  await page.keyboard.press('ArrowUp');
  await expect(inspector.getByLabel('X (m)', { exact: true })).toHaveValue(
    '7.01',
  );
  await page.getByRole('button', { name: '保存布局', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
    '已保存',
  );
  snapshot = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  const light = snapshot.entities.find(
    (entity: { name: string }) => entity.name === 'Editing light',
  );
  expect(light.observation.values.on).toBe(true);
  expect(
    snapshot.nodes.find(
      (node: { entity_id: string }) => node.entity_id === light.id,
    ).placement.position[0],
  ).toBe(7.01);
  expect(snapshot.relationships).toEqual(registered.relationships);
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await page.screenshot({
    path: 'test-results/lab-foundation/t04-layout-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  if (!desktopMigration)
    await page.setViewportSize({ width: 320, height: 844 });
  await expect(
    page.getByRole('tab', { name: 'Edit layout', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  const tools = (await page.locator('.world-canvas-tools').boundingBox())!,
    transforms = (await page.locator('.world-transform-tools').boundingBox())!;
  expect(tools.x + tools.width).toBeLessThan(transforms.x);
  await page.screenshot({
    path: `test-results/lab-foundation/t04-layout-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
    fullPage: true,
  });
  expect((await redHandle(page)).count).toBeGreaterThan(10);
  const mobileInspector = page.getByRole('complementary', {
    name: 'Object info',
  });
  await mobileInspector
    .getByLabel('Related object', { exact: true })
    .selectOption(benchId, { timeout: 10000 });
  await mobileInspector
    .getByRole('button', { name: 'Register relationship', exact: true })
    .click();
  await expect(
    mobileInspector.getByText('Manual registration · Unsaved', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/lab-foundation/t04-layout-${desktopMigration ? 'desktop' : 'mobile'}-relationships-en.png`,
    fullPage: true,
  });
  await mobileInspector.getByLabel('X (m)', { exact: true }).fill('8');
  await mobileInspector.locator('.world-placement').scrollIntoViewIfNeeded();
  await expect(
    mobileInspector.getByLabel('Rx (rad)', { exact: true }),
  ).toBeVisible();
  await expect(mobileInspector.getByLabel('Sx', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `test-results/lab-foundation/t04-layout-${desktopMigration ? 'desktop' : 'mobile'}-placement-en.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save layout', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Layout save status' }),
  ).toHaveText('Saved');
  const mobileSaved = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  expect(
    mobileSaved.nodes.find(
      (node: { entity_id: string }) => node.entity_id === light.id,
    ).placement.position[0],
  ).toBe(8);
  expect(
    mobileSaved.relationships.find(
      (relation: { source_id: string }) => relation.source_id === light.id,
    ).source,
  ).toBe('manual');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const credential = await page.request.post('/api/v1/api-keys', {
    headers: {
      origin: process.env.E2E_WEB_URL!,
      'x-csrf-token': session.csrf_token,
    },
    data: {
      name: 'Layout tutorial Agent',
      scopes: ['lab:full'],
      expires_in_days: 1,
    },
  });
  expect(credential.status()).toBe(201);
  const token = (await credential.json()).secret;
  const tutorial = JSON.parse(
    execFileSync('node', ['examples/lab/edit-layout.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LAB_API_BASE: process.env.E2E_API_URL,
        LAB_API_KEY: token,
      },
    }),
  );
  expect(tutorial.layout_version).toBe(10);
  expect(tutorial.beaker_id).not.toBe(tutorial.copied_entity_id);
  expect(tutorial.relationships).toHaveLength(2);
});
