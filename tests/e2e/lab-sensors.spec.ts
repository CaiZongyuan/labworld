import {
  expect,
  test,
  request as playwrightRequest,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.use({ locale: 'zh-CN' });
async function nonblankCanvas(page: Page) {
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
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const colors = new Set<string>();
    for (let index = 0; index < pixels.length; index += 16)
      colors.add(
        `${pixels[index] >> 4}:${pixels[index + 1] >> 4}:${pixels[index + 2] >> 4}`,
      );
    return colors.size;
  }, png.toString('base64'));
  expect(colors).toBeGreaterThan(20);
}
test('backend temperatures stay independent across browser closure, source expiry and recovery', async ({
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
    .fill(`sensors-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('sensor-browser-password');
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
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Backend temperature lab');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Backend temperature lab', exact: true }),
  ).toBeVisible();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = {
    origin: process.env.E2E_WEB_URL!,
    'x-csrf-token': session.csrf_token,
  };
  const credential = await (
    await page.request.post('/api/v1/api-keys', {
      headers,
      data: {
        name: 'Temperature Agent',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
    })
  ).json();
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${credential.secret}` },
  });
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  const paths: string[] = [];
  let lab = '';
  try {
    for (const [name, baseline_temperature] of [
      ['Sensor A', 20],
      ['Sensor B', 25],
    ] as const) {
      await page.getByRole('button', { name: '登记对象', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('定义版本').selectOption('sensor@1.0');
      if (name === 'Sensor A')
        await dialog
          .getByLabel('外观表示')
          .selectOption({ label: 'cube-draco · 1.0' });
      await dialog.getByLabel('名称', { exact: true }).fill(name);
      await dialog.getByRole('button', { name: '登记', exact: true }).click();
      await expect(
        inspector.getByRole('heading', { name, exact: true }),
      ).toBeVisible();
      await expect(
        inspector.getByText('未知 · 无观测', { exact: true }),
      ).toBeVisible();
      const entity = await inspector
        .locator('dt')
        .filter({ hasText: /^Entity$/ })
        .locator('+ dd')
        .innerText();
      lab = await inspector
        .locator('dt')
        .filter({ hasText: /^Lab$/ })
        .locator('+ dd')
        .innerText();
      const path = `/api/v1/lab/labs/${lab}/entities/${entity}`;
      paths.push(path);
      expect(
        (
          await agent.patch(path, {
            data: { name, configuration: { baseline_temperature } },
          })
        ).status(),
      ).toBe(200);
      await inspector
        .getByRole('button', { name: '启动程序', exact: true })
        .click();
      await expect(
        inspector.getByRole('region', { name: '观测温度' }),
      ).toBeVisible();
      await expect(
        page.getByRole('img', { name: new RegExp(`^${name}:`) }),
      ).toContainText('degC');
      await expect
        .poll(
          async () =>
            (await (await agent.get(path)).json()).observation?.values
              .temperature,
        )
        .toBeGreaterThan(baseline_temperature - 1);
      await expect(inspector.getByRole('switch')).toHaveCount(0);
    }
    await page
      .getByRole('button', { name: '选择 Sensor A', exact: true })
      .click();
    const reading = page.getByRole('img', { name: /^Sensor A:/ });
    await expect(reading).toBeVisible();
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await nonblankCanvas(page);
    const storageState = await page.context().storageState();
    const before = (await (await agent.get(paths[0])).json()).observation
      .sequence;
    await page.close();
    await expect
      .poll(
        async () =>
          (await (await agent.get(paths[0])).json()).observation.sequence,
      )
      .toBeGreaterThan(before);
    const context = await browser.newContext({
      storageState,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    const reopened = await context.newPage();
    reopened.on('pageerror', (error) => errors.push(error.name));
    try {
      await reopened.goto('/lab');
      await reopened
        .getByRole('combobox', { name: '打开 Lab' })
        .selectOption(lab);
      await reopened
        .getByRole('button', { name: '选择 Sensor A', exact: true })
        .click();
      const detail = reopened.getByRole('complementary', { name: '对象信息' });
      const temperature = detail.getByRole('region', { name: '观测温度' });
      await expect(temperature).toBeVisible();
      await detail
        .getByRole('button', { name: '停止程序', exact: true })
        .click();
      const retained = (await (await agent.get(paths[0])).json()).observation;
      await expect(
        temperature.getByText('观测已过期 · 保留最后值', { exact: true }),
      ).toBeVisible({ timeout: 10000 });
      const stable = await (await agent.get(paths[0])).json();
      expect(stable.observation.values).toEqual(retained.values);
      expect(stable.observation.received_at).toBe(retained.received_at);
      expect(
        (await (await reopened.request.get(paths[0])).json()).observation,
      ).toEqual(stable.observation);
      const property = stable.observation.properties.temperature;
      await expect(
        temperature.getByText(`${property.value} degC`, { exact: true }),
      ).toBeVisible();
      const sceneReading = reopened.getByRole('img', {
        name: `Sensor A: ${property.value} degC`,
        exact: true,
      });
      await expect(sceneReading).toContainText('观测已过期');
      await expect(sceneReading).toHaveAttribute(
        'title',
        [
          property.source,
          property.observed_at,
          property.received_at,
          '良好',
        ].join('\n'),
      );
      await reopened.screenshot({
        path: 'test-results/lab-foundation/t05-temperature-desktop.png',
        fullPage: true,
      });
      expect(
        (
          await agent.patch(paths[0], {
            data: {
              name: 'Sensor A',
              configuration: {},
              observation: { values: { temperature: 99 } },
            },
          })
        ).status(),
      ).toBe(400);
      expect((await (await agent.get(paths[0])).json()).observation).toEqual(
        stable.observation,
      );
      const run = stable.program_run.id;
      await detail
        .getByRole('button', { name: '启动程序', exact: true })
        .click();
      await expect(
        temperature.getByText('当前观测', { exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          async () =>
            (await (await agent.get(paths[0])).json()).observation.run_id,
        )
        .not.toBe(run);
      const second = (await (await agent.get(paths[1])).json()).observation;
      expect(second.values.temperature).toBeGreaterThan(24);
      expect(second.source).not.toBe(property.source);
      const script = JSON.parse(
        execFileSync(
          process.execPath,
          ['examples/lab/observe-temperature.mjs'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              LAB_API_BASE: process.env.E2E_API_URL,
              LAB_ID: lab,
              LAB_API_KEY: credential.secret,
            },
          },
        ),
      );
      expect(script.retained.freshness).toBe('stale');
      expect(script.recovered.freshness).toBe('current');
      await reopened.setViewportSize({ width: 320, height: 900 });
      await reopened
        .getByRole('button', { name: 'English', exact: true })
        .click();
      await reopened.getByRole('button', { name: 'Dark', exact: true }).click();
      await expect(
        reopened
          .getByRole('complementary', { name: 'Object info' })
          .getByRole('region', { name: 'Reported temperature' }),
      ).toBeVisible();
      await nonblankCanvas(reopened);
      const activeReading = reopened.getByRole('img', { name: /^Sensor A:/ });
      await expect(activeReading).toHaveCount(1);
      const bounds = await activeReading.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
      await reopened.screenshot({
        path: 'test-results/lab-foundation/t05-temperature-mobile-dark-en.png',
        fullPage: true,
      });
      await reopened
        .getByRole('complementary', { name: 'Object info' })
        .getByRole('region', { name: 'Reported temperature' })
        .scrollIntoViewIfNeeded();
      await reopened.screenshot({
        path: 'test-results/lab-foundation/t05-temperature-mobile-inspector-dark-en.png',
        fullPage: true,
      });
      expect(
        await reopened.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  } finally {
    await agent.dispose();
  }
});
