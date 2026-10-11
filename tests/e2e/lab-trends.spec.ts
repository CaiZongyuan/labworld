import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { showEntityDetails, showEntityOperations } from './lab-desktop';
import type {
  EntityTrend,
  LabEntity,
} from '../../packages/contracts/src/generated/types.gen';

test.use({ locale: 'zh-CN', hasTouch: true });
test.afterEach(async ({ page }, info) => {
  if (
    info.status !== info.expectedStatus &&
    new URL(page.url()).pathname === '/lab'
  )
    await page.screenshot({ path: info.outputPath('failure-workspace.png') });
});

async function newDevice(page: Page, definition: string, name: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`trend-${definition}-${Date.now()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('trend-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill(`Trend ${definition}`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  const details = await showEntityDetails(page);
  const entityId = await details
    .locator('dt')
    .filter({ hasText: /^Entity$/ })
    .locator('+ dd')
    .innerText();
  const labId = await details
    .locator('dt')
    .filter({ hasText: /^Lab$/ })
    .locator('+ dd')
    .innerText();
  await showEntityOperations(page);
  return {
    entityId,
    labId,
    path: `/api/v1/lab/labs/${labId}/entities/${entityId}`,
    inspector: page.getByRole('complementary', { name: '对象信息' }),
  };
}

type SceneMask = { x: number; y: number; width: number; height: number };
async function sensorLabelMask(page: Page): Promise<SceneMask[]> {
  const canvas = (await page.locator('.world-viewport canvas').boundingBox())!;
  const card = page
    .locator('.world-priority-label')
    .filter({ hasText: 'Persistent sensor' });
  await expect(card).toHaveCount(1);
  const label = (await card.boundingBox())!;
  return [
    {
      x: label.x - canvas.x,
      y: label.y - canvas.y,
      width: label.width,
      height: label.height,
    },
  ];
}
async function rasterDifference(
  page: Page,
  first: Buffer,
  second: Buffer,
  excluded: SceneMask[] = [],
) {
  return page.evaluate(
    async ({ images, excluded }) => {
      let width = 0;
      const pixels = await Promise.all(
        images.map(async (encoded) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          width = image.width;
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        }),
      );
      let changed = 0;
      for (let index = 0; index < pixels[0].length; index += 4) {
        const x = (index / 4) % width,
          y = Math.floor(index / 4 / width);
        if (
          excluded.some(
            (box) =>
              x >= box.x &&
              x < box.x + box.width &&
              y >= box.y &&
              y < box.y + box.height,
          )
        )
          continue;
        if (
          Math.abs(pixels[0][index] - pixels[1][index]) +
            Math.abs(pixels[0][index + 1] - pixels[1][index + 1]) +
            Math.abs(pixels[0][index + 2] - pixels[1][index + 2]) >
          30
        )
          changed++;
      }
      return changed;
    },
    { images: [first.toString('base64'), second.toString('base64')], excluded },
  );
}

test('a sensor recent-minute entry queries persistent SDK history and preserves camera while chart, tooltip and table agree', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`trend-browser-${Date.now()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('trend-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Persistent trends');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption('sensor@1.0');
  await dialog.getByLabel('名称', { exact: true }).fill('Persistent sensor');
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  const details = await showEntityDetails(page);
  const entityId = await details
    .locator('dt')
    .filter({ hasText: /^Entity$/ })
    .locator('+ dd')
    .innerText();
  const labId = await details
    .locator('dt')
    .filter({ hasText: /^Lab$/ })
    .locator('+ dd')
    .innerText();
  const entityPath = `/api/v1/lab/labs/${labId}/entities/${entityId}`;
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  await showEntityOperations(page);
  await inspector
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await expect(inspector.getByLabel('关键观测有效性')).toHaveText(
    '当前关键观测有效',
  );
  await expect(page.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const trend = async (): Promise<EntityTrend> => {
    const to = new Date().toISOString();
    const from = new Date(Date.parse(to) - 60000).toISOString();
    const response = await page.request.get(
      `${entityPath}/trend?${new URLSearchParams({ property: 'temperature', from, to, max_points: '600' })}`,
    );
    expect(response.status()).toBe(200);
    return response.json();
  };
  await expect
    .poll(async () => (await trend()).returned_sample_count)
    .toBeGreaterThanOrEqual(2);
  const canvas = page.locator('.world-viewport canvas');
  await expect
    .poll(async () => {
      const firstMask = await sensorLabelMask(page);
      const first = await canvas.screenshot();
      const secondMask = await sensorLabelMask(page);
      const second = await canvas.screenshot();
      return rasterDifference(page, first, second, [
        ...firstMask,
        ...secondMask,
      ]);
    })
    .toBe(0);
  const before = await canvas.screenshot({
    path: info.outputPath('camera-before.png'),
  });
  const beforeMask = await sensorLabelMask(page);
  const queried = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `${entityPath}/trend`,
  );
  await page.getByRole('button', { name: '最近 1 分钟', exact: true }).click();
  const result = (await (await queried).json()) as EntityTrend;
  writeFileSync(
    info.outputPath('first-sdk-trend.json'),
    JSON.stringify(result, null, 2),
  );
  expect(Date.parse(result.to) - Date.parse(result.from)).toBe(60000);
  expect(result.returned_sample_count).toBeGreaterThanOrEqual(2);
  const chart = inspector.getByRole('img', { name: '温度趋势 · degC' });
  await expect(chart).toBeVisible();
  const table = inspector.getByRole('table', { name: '趋势读数' });
  await expect(table).toBeVisible();
  const sample = result.segments[0].samples[0];
  await expect(
    table.locator('tbody tr').first().getByRole('cell').nth(1),
  ).toHaveText(sample.received_at);
  await expect(
    table.getByText(result.segments[0].source, { exact: true }).first(),
  ).toBeVisible();
  const cameraAfter = await canvas.screenshot({
    path: info.outputPath('camera-after.png'),
  });
  const cameraPixels = await rasterDifference(page, before, cameraAfter, [
    ...beforeMask,
    ...(await sensorLabelMask(page)),
  ]);
  expect(cameraPixels).toBe(0);
  await chart.scrollIntoViewIfNeeded();
  const points = chart.locator('circle[fill="var(--primary)"]');
  await expect(points.first()).toBeVisible();
  await expect(points.first()).toBeInViewport();
  const point = (await points.first().boundingBox())!;
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  const tooltip = page.getByRole('status').filter({ hasText: 'degC' });
  await expect(tooltip).toContainText('degC');
  await expect(tooltip).toContainText(result.segments[0].source);
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expect(tooltip).toContainText('Run:');
  await page.touchscreen.tap(
    point.x + point.width / 2,
    point.y + point.height / 2,
  );
  await expect(tooltip).toContainText('degC');
  await inspector
    .getByRole('button', { name: '停止程序', exact: true })
    .click();
  await expect(inspector.getByText('来源已停止，最后观测保留。')).toBeVisible();
  await expect
    .poll(async () =>
      (await trend()).gaps.some((gap) => gap.reasons.includes('run_stopped')),
    )
    .toBe(true);
  await inspector
    .getByRole('button', { name: '刷新趋势', exact: true })
    .click();
  await expect(
    inspector.getByText('来源已停止', { exact: true }).last(),
  ).toBeVisible();
  await inspector
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await expect(inspector.getByLabel('关键观测有效性')).toHaveText(
    '当前关键观测有效',
  );
  await expect
    .poll(
      async () =>
        new Set((await trend()).segments.map((segment) => segment.run_id)).size,
    )
    .toBe(2);
  await inspector
    .getByRole('button', { name: '刷新趋势', exact: true })
    .click();
  await expect(inspector.getByText('Run 切换', { exact: true })).toBeVisible();
  const latest = (await (
    await page.request.get(entityPath)
  ).json()) as LabEntity;
  expect(latest.program_run?.status).toBe('running');
  writeFileSync(
    info.outputPath('persistent-trend.json'),
    JSON.stringify(await trend(), null, 2),
  );
  await chart.screenshot({ path: info.outputPath('persistent-chart.png') });
  await page.screenshot({ path: info.outputPath('persistent-workspace.png') });
  const scene = (await canvas.boundingBox())!;
  const orbitBeforeMask = await sensorLabelMask(page);
  const orbitBefore = await canvas.screenshot();
  await page.mouse.move(
    scene.x + scene.width * 0.55,
    scene.y + scene.height * 0.7,
  );
  await page.mouse.down();
  await page.mouse.move(
    scene.x + scene.width * 0.55 + 70,
    scene.y + scene.height * 0.7 + 30,
    { steps: 12 },
  );
  await page.mouse.up();
  const orbitAfter = await canvas.screenshot({
    path: info.outputPath('orbit-negative.png'),
  });
  const orbitPixels = await rasterDifference(page, orbitBefore, orbitAfter, [
    ...orbitBeforeMask,
    ...(await sensorLabelMask(page)),
  ]);
  expect(orbitPixels).toBeGreaterThan(30);
  writeFileSync(
    info.outputPath('camera-oracle.json'),
    JSON.stringify({ cameraPixels, orbitPixels, masks: beforeMask }, null, 2),
  );
  expect(errors).toEqual([]);
});

test('actual centrifuge speed extrema stay in the chart and four accepted viewports keep trends readable', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { path, inspector } = await newDevice(
    page,
    'centrifuge',
    'Trend centrifuge',
  );
  await inspector
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await expect(inspector.getByLabel('关键观测有效性')).toHaveText(
    '当前关键观测有效',
  );
  await inspector.getByLabel('目标转速 (rpm)').fill('14000');
  await inspector.getByLabel('目标温度 (degC)').fill('22');
  await inspector.getByLabel('任务时长 (s)').fill('6');
  await inspector
    .getByRole('button', { name: '开始离心', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(path)).json()) as LabEntity).task
          ?.status,
      { timeout: 30000 },
    )
    .toBe('completed');
  await inspector
    .getByRole('button', { name: '查看趋势', exact: true })
    .click();
  const queried = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${path}/trend` &&
      new URL(response.url()).searchParams.get('property') === 'speed',
  );
  await inspector
    .getByRole('button', { name: '转速趋势', exact: true })
    .click();
  const dto = (await (await queried).json()) as EntityTrend;
  const maximum = Math.max(
    ...dto.segments.flatMap((segment) =>
      segment.samples.map((sample) => sample.value),
    ),
  );
  expect(maximum).toBe(14000);
  const chart = inspector.getByRole('img', { name: '转速趋势 · rpm' });
  await chart.scrollIntoViewIfNeeded();
  await expect(chart).toBeVisible();
  const extents = await chart.evaluate((element) => {
    const svg =
      element instanceof SVGSVGElement
        ? element
        : element.querySelector('svg')!;
    const height = svg.viewBox.baseVal.height;
    return {
      height,
      points: Array.from(
        svg.querySelectorAll('circle[fill="var(--primary)"]'),
      ).map((point) => ({
        y: Number(point.getAttribute('cy')),
        radius: Number(point.getAttribute('r')),
      })),
    };
  });
  expect(extents.points.length).toBeGreaterThan(2);
  expect(
    extents.points.every(
      (point) => point.radius > 0 && point.y >= 0 && point.y <= extents.height,
    ),
  ).toBe(true);
  expect(Math.min(...extents.points.map((point) => point.y))).toBeLessThan(
    extents.height * 0.25,
  );
  const viewports = [
    { width: 1440, height: 1000, english: false, dark: false },
    { width: 1920, height: 1080, english: false, dark: false },
    { width: 390, height: 844, english: false, dark: false },
    { width: 320, height: 844, english: true, dark: true },
  ];
  const rectangles: Record<string, unknown>[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    if (viewport.english)
      await page.getByRole('button', { name: 'English', exact: true }).click();
    if (viewport.dark)
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const owner = page.getByRole('complementary', {
      name: viewport.english ? 'Object info' : '对象信息',
    });
    const plot = owner.getByRole('img', {
      name: viewport.english ? 'Speed trend · rpm' : '转速趋势 · rpm',
    });
    if (viewport.width <= 560) await showEntityOperations(page);
    await plot.scrollIntoViewIfNeeded();
    await expect(plot).toBeInViewport();
    const box = (await plot.boundingBox())!;
    const panel = (await owner.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(180);
    expect(box.x).toBeGreaterThanOrEqual(panel.x);
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const refresh = owner.getByRole('button', {
      name: viewport.english ? 'Refresh trend' : '刷新趋势',
      exact: true,
    });
    if (viewport.width <= 560)
      expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const peakIndex = await plot.evaluate((element) => {
      const points = Array.from(
        element.querySelectorAll('circle[fill="var(--primary)"]'),
      );
      return points.reduce(
        (index, point, next) =>
          Number(point.getAttribute('cy')) <
          Number(points[index].getAttribute('cy'))
            ? next
            : index,
        0,
      );
    });
    const point = (await plot
      .locator('circle[fill="var(--primary)"]')
      .nth(peakIndex)
      .boundingBox())!;
    await page.touchscreen.tap(
      point.x + point.width / 2,
      point.y + point.height / 2,
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'rpm' }),
    ).toContainText('14000 rpm');
    await expect(
      owner.getByRole('table', {
        name: viewport.english ? 'Trend readings' : '趋势读数',
      }),
    ).toContainText('14000 rpm');
    await page.screenshot({
      path: info.outputPath(
        `trend-${viewport.width}-${viewport.english ? 'en' : 'zh'}.png`,
      ),
    });
    await plot.press('Escape');
    await expect(
      page.getByRole('status').filter({ hasText: 'rpm' }),
    ).not.toBeVisible();
    rectangles.push({ ...viewport, box, panel });
  }
  writeFileSync(
    info.outputPath('accepted-trend-rectangles.json'),
    JSON.stringify(rectangles, null, 2),
  );
  writeFileSync(
    info.outputPath('actual-rpm-trend.json'),
    JSON.stringify(dto, null, 2),
  );
});
