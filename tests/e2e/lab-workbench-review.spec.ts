import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });
const evidence =
  process.env.LAB_WORKBENCH_EVIDENCE ?? '.scratch/workbench/review';
mkdirSync(evidence, { recursive: true });
test.afterEach(async ({ page }, info) => {
  const name = info.title.includes('camera') ? 'camera' : 'history';
  writeFileSync(
    join(evidence, `${name}-result.json`),
    JSON.stringify(
      {
        status: info.status,
        positions: info.errors.flatMap(
          (error) =>
            error.stack?.match(/lab-workbench-review\.spec\.ts:\d+:\d+/g) ?? [],
        ),
      },
      null,
      2,
    ),
  );
  if (
    info.status !== info.expectedStatus &&
    new URL(page.url()).pathname === '/lab'
  )
    await page.screenshot({ path: join(evidence, `${name}-failure.png`) });
});

async function member(page: Page) {
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`workbench-review-${crypto.randomUUID()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('workbench-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  const identity = await (
    await page.request.get('/api/v1/auth/session')
  ).json();
  return {
    origin: process.env.E2E_WEB_URL!,
    'x-csrf-token': identity.csrf_token,
  };
}
async function register(
  page: Page,
  headers: Record<string, string>,
  lab: string,
  definition: string,
  name: string,
) {
  const response = await page.request.post(`/api/v1/lab/labs/${lab}/entities`, {
    headers,
    data: {
      definition_id: definition,
      definition_version: '1.0',
      name,
      reality: 'simulated',
      configuration: {},
      representation_id: null,
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function lab(page: Page, headers: Record<string, string>, name: string) {
  const response = await page.request.post('/api/v1/lab/labs', {
    headers,
    data: { name },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function bounds(page: Page, locator: Locator) {
  const rect = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 1);
  return rect;
}

// The unchanged teal Robot is a visible landmark; no camera or scene internals are read.
async function robotPixels(
  page: Page,
  region?: { x: number; y: number; width: number; height: number },
) {
  const png = await page.locator('canvas').screenshot();
  const pixels = await page.evaluate(
    async ({ encoded, region }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < data.length; i += 4) {
        const x = (i / 4) % image.width,
          y = Math.floor(i / 4 / image.width);
        if (
          region &&
          (x < region.x ||
            x > region.x + region.width ||
            y < region.y ||
            y > region.y + region.height)
        )
          continue;
        if (
          data[i + 1] > data[i] * 1.2 &&
          data[i + 2] > data[i] * 1.2 &&
          data[i + 2] > 45
        )
          points.push({ x, y });
      }
      const xs = points.map((point) => point.x),
        ys = points.map((point) => point.y);
      return {
        count: points.length,
        x: points.length ? Math.min(...xs) : 0,
        y: points.length ? Math.min(...ys) : 0,
        width: points.length ? Math.max(...xs) - Math.min(...xs) : 0,
        height: points.length ? Math.max(...ys) - Math.min(...ys) : 0,
      };
    },
    { encoded: png.toString('base64'), region },
  );
  return { png, pixels };
}
async function steadyRobot(page: Page) {
  let previous = (await robotPixels(page)).pixels;
  await expect
    .poll(
      async () => {
        const next = (await robotPixels(page)).pixels;
        const delta =
          Math.abs(next.x - previous.x) +
          Math.abs(next.y - previous.y) +
          Math.abs(next.width - previous.width) +
          Math.abs(next.height - previous.height);
        previous = next;
        return delta;
      },
      { timeout: 30000 },
    )
    .toBeLessThan(2);
  return robotPixels(page);
}

test('real World structural updates preserve an orbited camera until explicit Fit', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const headers = await member(page),
    worldLab = await lab(page, headers, 'Camera review Lab');
  const bench = await register(
    page,
    headers,
    worldLab.id,
    'bench',
    'Original bench',
  );
  await register(page, headers, worldLab.id, 'robot', 'Original Robot');
  const otherContext = await browser.newContext({ locale: 'zh-CN' });
  try {
    const other = await otherContext.newPage(),
      otherHeaders = await member(other);
    await other.goto('/assets');
    await other
      .getByLabel('GLB 文件')
      .setInputFiles('tests/fixtures/lab/cube-draco.glb');
    await other
      .getByRole('dialog')
      .getByRole('button', { name: '发布资产' })
      .click();
    await expect(
      other.getByText('cube-draco.glb', { exact: true }),
    ).toBeVisible();
    const assets = await (await other.request.get('/api/v1/lab/assets')).json();
    const representation = assets.data.find(
      (asset: { name: string }) => asset.name === 'cube-draco',
    ).representation.id;
    await page.goto(`/lab?lab=${worldLab.id}`);
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const initial = await steadyRobot(page);
    expect(initial.pixels.count).toBeGreaterThan(100);
    const canvas = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(
      canvas.x + canvas.width * 0.8,
      canvas.y + canvas.height * 0.35,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvas.x + canvas.width * 0.8 - 100,
      canvas.y + canvas.height * 0.35 + 50,
      { steps: 20 },
    );
    await page.mouse.up();
    const orbited = await steadyRobot(page);
    expect(
      Math.abs(orbited.pixels.x - initial.pixels.x) +
        Math.abs(orbited.pixels.y - initial.pixels.y),
    ).toBeGreaterThan(10);
    const region = {
      x: orbited.pixels.x - 15,
      y: orbited.pixels.y - 15,
      width: orbited.pixels.width + 30,
      height: orbited.pixels.height + 30,
    };
    const measurements: unknown[] = [
      { operation: 'orbit', pixels: orbited.pixels },
    ];
    const verify = async (operation: string) => {
      await expect(page.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const current = await robotPixels(page, region);
      measurements.push({ operation, pixels: current.pixels });
      writeFileSync(
        join(evidence, 'camera-landmarks.json'),
        JSON.stringify(measurements, null, 2),
      );
      writeFileSync(join(evidence, `camera-${operation}.png`), current.png);
      expect(current.pixels.count).toBeGreaterThan(orbited.pixels.count * 0.7);
      expect(Math.abs(current.pixels.x - orbited.pixels.x)).toBeLessThan(3);
      expect(Math.abs(current.pixels.y - orbited.pixels.y)).toBeLessThan(3);
      expect(
        Math.abs(current.pixels.width - orbited.pixels.width),
      ).toBeLessThan(3);
      expect(
        Math.abs(current.pixels.height - orbited.pixels.height),
      ).toBeLessThan(3);
    };
    writeFileSync(join(evidence, 'camera-orbited.png'), orbited.png);
    const before = await (
      await other.request.get(`/api/v1/lab/labs/${worldLab.id}/world`)
    ).json();
    const copied = await other.request.post(
      `/api/v1/lab/labs/${worldLab.id}/entities/${bench.id}/copies`,
      {
        headers: otherHeaders,
        data: {
          expected_version: before.lab.layout_version,
          name: 'Remote far bench',
          placement: {
            position: [15, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      },
    );
    expect(copied.status()).toBe(201);
    const remote = await copied.json();
    await page.getByRole('button', { name: '打开对象目录' }).click();
    await expect(
      page.getByRole('button', { name: '选择 Remote far bench', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '关闭对象目录' }).click();
    await verify('added-node');
    expect(
      (
        await other.request.post(
          `/api/v1/lab/labs/${worldLab.id}/entities/${remote.id}/archive`,
          { headers: otherHeaders },
        )
      ).status(),
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/v1/lab/labs/${worldLab.id}/world`)
            ).json()
          ).entities.find((entity: { id: string }) => entity.id === remote.id)
            .archived_at,
      )
      .toBeTruthy();
    await page.getByRole('button', { name: '打开对象目录' }).click();
    await expect(
      page.getByRole('button', { name: '选择 Remote far bench', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '关闭对象目录' }).click();
    await verify('archived-node');
    const loadedGlb = page.waitForResponse(async (response) => {
      const url = new URL(response.url());
      if (
        response.request().resourceType() !== 'fetch' ||
        url.origin !== new URL(process.env.E2E_WEB_URL!).origin ||
        !url.pathname.startsWith('/objects/')
      )
        return false;
      const bytes = await response.body();
      return bytes.subarray(0, 4).toString() === 'glTF';
    });
    const changed = await other.request.put(
      `/api/v1/lab/labs/${worldLab.id}/entities/${bench.id}/appearance`,
      { headers: otherHeaders, data: { representation_id: representation } },
    );
    expect(changed.status()).toBe(200);
    await page.getByRole('button', { name: '打开对象目录' }).click();
    await page
      .getByRole('button', { name: '选择 Original bench', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', { name: '对象信息' }),
    ).toContainText(representation);
    await page.getByRole('button', { name: '关闭对象目录' }).click();
    await page.getByRole('button', { name: '关闭对象信息' }).click();
    await loadedGlb;
    await verify('appearance-loaded');
    await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
    const fitted = await steadyRobot(page);
    expect(
      Math.abs(fitted.pixels.x - orbited.pixels.x) +
        Math.abs(fitted.pixels.y - orbited.pixels.y),
    ).toBeGreaterThan(10);
    const nextLab = await lab(
      other,
      otherHeaders,
      'First frame in another Lab',
    );
    await register(other, otherHeaders, nextLab.id, 'robot', 'Other Lab Robot');
    await page.goto(`/lab?lab=${nextLab.id}`);
    expect((await steadyRobot(page)).pixels.count).toBeGreaterThan(100);
  } finally {
    await otherContext.close();
  }
});

test('narrow history keeps filters, real command records and pagination reachable and returns to its Entity', async ({
  page,
}) => {
  test.skip(
    desktopMigration,
    'Product narrow-screen coverage resumes after Migration Gate',
  );
  test.setTimeout(180000);
  const headers = await member(page),
    worldLab = await lab(page, headers, 'History review Lab');
  const lamp = await register(
    page,
    headers,
    worldLab.id,
    'light',
    'History lamp',
  );
  const path = `/api/v1/lab/labs/${worldLab.id}/entities/${lamp.id}`;
  expect(
    (await page.request.post(`${path}/program/start`, { headers })).status(),
  ).toBe(201);
  for (let i = 0; i < 25; i++) {
    const command = await page.request.post(`${path}/actions`, {
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      data: { capability: 'light.set_power', parameters: { on: i % 2 === 0 } },
    });
    expect(command.status()).toBe(202);
  }
  const measurements: unknown[] = [];
  for (const [width, english] of [
    [390, false],
    [320, true],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/lab?lab=${worldLab.id}&entity=${lamp.id}`);
    await expect(
      page.getByRole('complementary', { name: '对象信息' }),
    ).toBeVisible();
    if (english) {
      await page.getByRole('button', { name: 'English' }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
    }
    const directory = page.getByRole('button', {
      name: english ? 'Open object directory' : '打开对象目录',
    });
    await directory.click();
    const inspector = page.getByRole('button', {
      name: english ? 'Open object details' : '打开对象信息',
    });
    await expect(inspector).toHaveAttribute('aria-expanded', 'false');
    await inspector.click();
    await expect(
      page.getByRole('complementary', {
        name: english ? 'Object directory' : '对象目录',
      }),
    ).toBeHidden();
    await expect(inspector).toHaveAttribute('aria-expanded', 'true');
    const trigger = page.getByRole('button', {
      name: english ? 'Open run history' : '打开运行历史',
    });
    await trigger.click();
    const surface = page.locator('.world-history-surface');
    const history = page.getByRole('region', {
      name: english ? 'Run history' : '运行历史',
    });
    const panelRect = await bounds(page, surface);
    await history
      .getByRole('tab', { name: english ? 'Commands' : '命令', exact: true })
      .click();
    const query = history.getByRole('button', {
      name: english ? 'Query history' : '查询历史',
      exact: true,
    });
    const from = history.getByLabel(english ? 'From' : '开始时间', {
      exact: true,
    });
    await from.scrollIntoViewIfNeeded();
    await from.fill(`${(await from.inputValue()).slice(0, 10)}T00:00`);
    await query.scrollIntoViewIfNeeded();
    await bounds(page, query);
    await query.click();
    await expect(history.locator('.world-history-record')).toHaveCount(20);
    const more = history.getByRole('button', {
      name: english ? 'Earlier records' : '更早记录',
      exact: true,
    });
    await more.scrollIntoViewIfNeeded();
    const moreRect = await bounds(page, more);
    await more.click();
    await expect(history.locator('.world-history-record')).toHaveCount(25);
    const scroll = await surface.evaluate((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
      total: element.scrollHeight,
      overflow: getComputedStyle(element).overflowY,
    }));
    expect(scroll.total).toBeGreaterThan(scroll.height);
    expect(scroll.top).toBeGreaterThan(0);
    expect(['auto', 'scroll']).toContain(scroll.overflow);
    await page.screenshot({
      path: join(evidence, `history-${width}-pagination.png`),
    });
    await surface
      .getByRole('button', {
        name: english ? 'Close run history' : '关闭运行历史',
        exact: true,
      })
      .click();
    await expect(trigger).toBeFocused();
    await expect(
      page.getByRole('complementary', {
        name: english ? 'Object info' : '对象信息',
      }),
    ).toContainText(lamp.id);
    measurements.push({ width, panelRect, moreRect, scroll });
  }
  writeFileSync(
    join(evidence, 'history-rectangles.json'),
    JSON.stringify(measurements, null, 2),
  );
  expect(
    (await page.request.post(`${path}/program/stop`, { headers })).status(),
  ).toBe(200);
});
