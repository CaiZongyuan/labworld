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

async function rasterDifference(page: Page, first: Buffer, second: Buffer) {
  return page.evaluate(
    async (images) => {
      const pixels = await Promise.all(
        images.map(async (encoded) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        }),
      );
      let changed = 0;
      for (let index = 0; index < pixels[0].length; index += 4)
        if (
          Math.abs(pixels[0][index] - pixels[1][index]) +
            Math.abs(pixels[0][index + 1] - pixels[1][index + 1]) +
            Math.abs(pixels[0][index + 2] - pixels[1][index + 2]) >
          30
        )
          changed++;
      return changed;
    },
    [first.toString('base64'), second.toString('base64')],
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
    .poll(async () =>
      rasterDifference(
        page,
        await canvas.screenshot(),
        await canvas.screenshot(),
      ),
    )
    .toBe(0);
  const before = await canvas.screenshot({
    path: info.outputPath('camera-before.png'),
  });
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
  expect(await rasterDifference(page, before, cameraAfter)).toBe(0);
  const points = chart.locator('circle[fill="var(--primary)"]');
  await expect(points.first()).toBeVisible();
  const point = (await points.first().boundingBox())!;
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  const tooltip = page.getByRole('tooltip');
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
  expect(errors).toEqual([]);
});
