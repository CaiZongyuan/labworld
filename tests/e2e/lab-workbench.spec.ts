import {
  expect,
  test,
  type Page,
  type Locator,
  type Request,
} from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({ locale: 'zh-CN' });
const evidence =
  process.env.LAB_WORKBENCH_EVIDENCE ?? '.scratch/workbench/application';
mkdirSync(evidence, { recursive: true });
const rectangleChecks: unknown[] = [];
test.beforeEach(() => {
  rectangleChecks.length = 0;
});
test.afterEach(async ({ page }, info) => {
  const stem = info.title.includes('orbited') ? 'desktop' : 'mobile';
  writeFileSync(
    join(evidence, `${stem}-assertions.json`),
    JSON.stringify(
      {
        status: info.status,
        positions: info.errors.flatMap(
          (error) =>
            error.stack?.match(/lab-workbench\.spec\.ts:\d+:\d+/g) ?? [],
        ),
        rectangleChecks,
      },
      null,
      2,
    ),
  );
  if (
    info.status !== info.expectedStatus &&
    new URL(page.url()).pathname === '/lab'
  )
    await page.screenshot({ path: join(evidence, `${stem}-failure.png`) });
});

async function seed(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`workbench-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('workbench-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('名称', { exact: true })
    .fill('Spatial acceptance Lab');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Spatial acceptance Lab', exact: true }),
  ).toBeVisible();
  const labId = new URL(page.url()).searchParams.get('lab')!;
  expect(labId).toBeTruthy();
  for (const [definition, name] of [
    ['bench', 'North bench'],
    ['robot', 'Robot A'],
  ]) {
    await page.getByRole('button', { name: '登记对象', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
    await dialog.getByLabel('名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '登记', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('button', { name: `选择 ${name}`, exact: true }),
    ).toBeVisible();
  }
  const world = await (
    await page.request.get(`/api/v1/lab/labs/${labId}/world`)
  ).json();
  const entityId = world.entities.find(
    (entry: { name: string }) => entry.name === 'North bench',
  ).id as string;
  return { labId, entityId, world };
}

async function difference(page: Page, first: Buffer, second: Buffer) {
  return page.evaluate(
    async ([left, right]) => {
      const load = async (encoded: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return {
          width: image.width,
          height: image.height,
          pixels: context.getImageData(0, 0, image.width, image.height).data,
        };
      };
      const a = await load(left),
        b = await load(right);
      if (a.width !== b.width || a.height !== b.height) return 1;
      let changed = 0,
        samples = 0;
      for (let i = 0; i < a.pixels.length; i += 16) {
        samples++;
        if (
          Math.abs(a.pixels[i] - b.pixels[i]) +
            Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
            Math.abs(a.pixels[i + 2] - b.pixels[i + 2]) >
          40
        )
          changed++;
      }
      return changed / samples;
    },
    [first.toString('base64'), second.toString('base64')],
  );
}

async function settledCanvas(page: Page) {
  let previous = await page.locator('canvas').screenshot();
  await expect
    .poll(
      async () => {
        const next = await page.locator('canvas').screenshot();
        const delta = await difference(page, previous, next);
        previous = next;
        return delta;
      },
      { timeout: 30000 },
    )
    .toBeLessThan(0.002);
  return previous;
}

async function canvasPixels(page: Page) {
  const png = await settledCanvas(page);
  const colors = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const values = new Set<string>();
    for (let i = 0; i < pixels.length; i += 16)
      values.add(
        `${pixels[i] >> 4}:${pixels[i + 1] >> 4}:${pixels[i + 2] >> 4}`,
      );
    return values.size;
  }, png.toString('base64'));
  expect(colors).toBeGreaterThan(20);
  return png;
}

async function withinViewport(page: Page, locator: Locator) {
  const rect = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  rectangleChecks.push({ locator: locator.toString(), rect, viewport });
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 1);
  return rect;
}

test('the real spatial workbench gives the canvas most of the business area and preserves an orbited camera', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  const { labId, entityId, world } = await seed(page);
  const identity = await (
    await page.request.get('/api/v1/auth/session')
  ).json();
  const secondLab = await (
    await page.request.post('/api/v1/lab/labs', {
      headers: {
        origin: process.env.E2E_WEB_URL!,
        'x-csrf-token': identity.csrf_token,
      },
      data: { name: 'Second acceptance Lab' },
    })
  ).json();
  const subscriptions: Request[] = [];
  const closed = new Set<Request>();
  page.on('request', (request) => {
    if (request.url().endsWith('/world/subscribe')) subscriptions.push(request);
  });
  page.on('requestfailed', (request) => closed.add(request));
  page.on('requestfinished', (request) => closed.add(request));
  await page.goto(`/lab?lab=${labId}`);
  await expect(page.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.getByRole('complementary', { name: '对象目录' }),
  ).toBeHidden();
  await expect(
    page.getByRole('complementary', { name: '对象信息' }),
  ).toBeHidden();
  const rectangles: unknown[] = [];
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const canvas = await withinViewport(page, page.locator('canvas'));
    const business = (await page.locator('.world-page').boundingBox())!;
    const ratio =
      (canvas.width * canvas.height) / (business.width * business.height);
    expect(ratio).toBeGreaterThanOrEqual(0.65);
    await canvasPixels(page);
    rectangles.push({ width, canvas, business, ratio });
    await page.screenshot({ path: join(evidence, `desktop-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '收起导航' }).click();
  await expect(page.locator('#app-sidebar')).toHaveAttribute(
    'data-compact',
    'true',
  );
  await expect(
    page.getByRole('link', { name: '设置', exact: true }),
  ).toHaveCount(1);
  const beforeOrbit = await settledCanvas(page);
  const rect = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(
    rect.x + rect.width * 0.55,
    rect.y + rect.height * 0.45,
  );
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width * 0.55 + 100,
    rect.y + rect.height * 0.45 + 40,
    { steps: 20 },
  );
  await page.mouse.up();
  const orbited = await settledCanvas(page);
  const orbitDelta = await difference(page, beforeOrbit, orbited);
  writeFileSync(
    join(evidence, 'orbit-movement.json'),
    JSON.stringify({ orbitDelta }, null, 2),
  );
  expect(orbitDelta).toBeGreaterThan(0.03);
  const openDirectory = page.getByRole('button', { name: '打开对象目录' });
  await openDirectory.click();
  await page.getByRole('button', { name: '关闭对象目录' }).click();
  await expect(openDirectory).toBeFocused();
  const afterPanels = await settledCanvas(page);
  const panelDelta = await difference(page, orbited, afterPanels);
  writeFileSync(
    join(evidence, 'desktop-rectangles.json'),
    JSON.stringify({ rectangles, panelDelta }, null, 2),
  );
  writeFileSync(join(evidence, 'orbited-before-panels.png'), orbited);
  writeFileSync(join(evidence, 'orbited-after-panels.png'), afterPanels);
  expect(panelDelta).toBeLessThan(0.025);
  expect(subscriptions).toHaveLength(1);
  await openDirectory.click();
  await page
    .getByRole('button', { name: '选择 North bench', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`entity=${entityId}`));
  await page.getByRole('button', { name: '关闭对象目录' }).click();
  await page.getByRole('button', { name: '关闭对象信息' }).click();
  await expect(
    page.getByRole('button', { name: '打开对象信息' }),
  ).toBeFocused();
  expect(subscriptions).toHaveLength(1);
  await page.getByLabel('打开 Lab', { exact: true }).selectOption(secondLab.id);
  await expect(
    page.getByRole('heading', { name: 'Second acceptance Lab', exact: true }),
  ).toBeVisible();
  await expect.poll(() => subscriptions.length).toBe(2);
  await expect.poll(() => closed.has(subscriptions[0])).toBe(true);
  await page.getByLabel('打开 Lab', { exact: true }).selectOption(labId);
  await expect(
    page.getByRole('heading', { name: 'Spatial acceptance Lab', exact: true }),
  ).toBeVisible();
  await expect.poll(() => subscriptions.length).toBe(3);
  await expect.poll(() => closed.has(subscriptions[1])).toBe(true);
  await openDirectory.click();
  await page
    .getByRole('button', { name: '选择 North bench', exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole('complementary', { name: '对象信息' }),
  ).toContainText(entityId);
  const after = await (
    await page.request.get(`/api/v1/lab/labs/${labId}/world`)
  ).json();
  expect(after.nodes).toEqual(world.nodes);
  expect(after.lab.layout_version).toBe(world.lab.layout_version);
  await page.goto(
    `/lab?lab=${labId}&entity=00000000-0000-0000-0000-000000000000`,
  );
  await expect(page.getByText('找不到此对象。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除对象链接' }).click();
  await expect(
    page.getByRole('complementary', { name: '对象信息' }),
  ).toBeHidden();
  expect(errors).toEqual([]);
  writeFileSync(
    join(evidence, 'subscription-lifecycle.json'),
    JSON.stringify(
      {
        requests: subscriptions.length,
        closed: subscriptions.filter((request) => closed.has(request)).length,
      },
      null,
      2,
    ),
  );
});

test('the real workbench keeps its scene, contextual panels, focus and touch commands usable on narrow screens', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { labId, entityId } = await seed(page);
  const rectangles: unknown[] = [];
  for (const [width, english] of [
    [390, false],
    [320, true],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/lab?lab=${labId}&entity=${entityId}&view=space`);
    await expect(
      page.getByRole('complementary', { name: '对象信息' }),
    ).toBeVisible();
    if (english) {
      await page.getByRole('button', { name: 'English', exact: true }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
    }
    const inspector = page.getByRole('complementary', {
      name: english ? 'Object info' : '对象信息',
    });
    const sceneRect = await withinViewport(page, page.locator('canvas'));
    const inspectorRect = await withinViewport(page, inspector);
    expect(sceneRect.y + sceneRect.height).toBeLessThanOrEqual(
      inspectorRect.y + 1,
    );
    const openDirectory = page.getByRole('button', {
      name: english ? 'Open object directory' : '打开对象目录',
    });
    const target = (await openDirectory.boundingBox())!;
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    const toolbarTargets = [];
    for (const button of await page
      .locator('.world-page .lab-toolbar-actions > button')
      .all()) {
      await expect(button).toBeVisible();
      const rect = await withinViewport(page, button);
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
      toolbarTargets.push({
        label:
          (await button.getAttribute('aria-label')) ??
          (await button.innerText()),
        rect,
      });
    }
    await openDirectory.click();
    await page
      .getByRole('button', {
        name: english ? 'Close object directory' : '关闭对象目录',
      })
      .click();
    await expect(openDirectory).toBeFocused();
    await openDirectory.click();
    await openDirectory.press('Escape');
    await expect(openDirectory).toBeFocused();
    await expect(
      page.getByRole('complementary', {
        name: english ? 'Object directory' : '对象目录',
      }),
    ).toBeHidden();
    await openDirectory.click();
    await page
      .getByRole('button', {
        name: english ? 'Select Robot A' : '选择 Robot A',
        exact: true,
      })
      .click();
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('Robot A');
    await expect(
      page.getByRole('complementary', {
        name: english ? 'Object directory' : '对象目录',
      }),
    ).toBeHidden();
    const register = page.getByRole('button', {
      name: english ? 'Register object' : '登记对象',
      exact: true,
    });
    const retry = page.getByRole('button', {
      name: english ? 'Retry' : '重试',
      exact: true,
    });
    await expect(register).toBeVisible();
    await expect(retry).toBeVisible();
    const registerRect = await withinViewport(page, register);
    const retryRect = await withinViewport(page, retry);
    expect(registerRect.height).toBeGreaterThanOrEqual(44);
    expect(retryRect.height).toBeGreaterThanOrEqual(44);
    await register.click();
    const registration = page.getByRole('dialog');
    await expect(registration).toBeVisible();
    await page.screenshot({
      path: join(evidence, `mobile-${width}-registration.png`),
    });
    await registration
      .getByRole('button', { name: english ? 'Cancel' : '取消', exact: true })
      .click();
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/labs/${labId}/world`) &&
          response.request().method() === 'GET' &&
          response.status() === 200,
      ),
      retry.click(),
    ]);
    await expect(inspector).toContainText('Robot A');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await canvasPixels(page);
    rectangles.push({
      width,
      sceneRect,
      inspectorRect,
      target,
      registerRect,
      retryRect,
      toolbarTargets,
    });
    await page.screenshot({
      path: join(
        evidence,
        `mobile-${width}-${english ? 'en-dark' : 'zh-light'}.png`,
      ),
    });
  }
  writeFileSync(
    join(evidence, 'mobile-rectangles.json'),
    JSON.stringify(rectangles, null, 2),
  );
});
