import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const evidence =
  process.env.LAB_DEVICE_DETAILS_EVIDENCE ??
  '.scratch/30-vnext-device-details/application';
mkdirSync(evidence, { recursive: true });
test.use({ locale: 'zh-CN' });
test.afterEach(async ({ page }, info) => {
  if (
    info.status !== info.expectedStatus &&
    new URL(page.url()).pathname === '/lab'
  )
    await page.screenshot({
      path: join(
        evidence,
        `${info.title.replace(/[^a-z0-9]+/gi, '-')}-failure.png`,
      ),
      animations: 'disabled',
    });
});
async function member(page: Page, labName: string) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`details-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('details-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill(labName);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: labName, exact: true }),
  ).toBeVisible();
}
async function register(page: Page, definition: string, name: string) {
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
  await dialog.getByLabel('身份来源').selectOption('simulated');
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function rectangle(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}
async function exposedScene(page: Page, inspector: Locator) {
  const canvas = page.locator('.world-viewport canvas');
  const scene = await rectangle(canvas);
  const info = await rectangle(inspector);
  expect(scene.height).toBeGreaterThanOrEqual(180);
  expect(scene.y + scene.height).toBeLessThanOrEqual(info.y + 1);
  const probes = await canvas.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [0.1, 0.5, 0.9].flatMap((x) =>
      [0.1, 0.5, 0.9].map((y) => {
        const hit = document.elementFromPoint(
          box.x + box.width * x,
          box.y + box.height * y,
        );
        return hit === element || !!hit?.closest('.world-viewport');
      }),
    );
  });
  expect(probes).toHaveLength(9);
  expect(probes.every(Boolean)).toBe(true);
  return { scene, info, probes };
}
async function colors(page: Page) {
  const screenshot = await page.locator('.world-viewport canvas').screenshot();
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const palette = new Set<string>();
    for (let i = 0; i < data.length; i += 16)
      palette.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return palette.size;
  }, screenshot.toString('base64'));
}
for (const scenario of [
  {
    name: 'short height',
    stem: 'short-height',
    height: 640,
    labName: 'Ready device Lab',
  },
  {
    name: 'long valid Lab name',
    stem: 'long-name',
    height: 844,
    labName:
      'Laboratory shared device inspection with temperature source status and independent centrifuge task results '
        .repeat(2)
        .slice(0, 120),
  },
]) {
  test(`adaptive mobile details fit ${scenario.name}`, async ({ page }) => {
    test.setTimeout(60000);
    await member(page, scenario.labName);
    await register(page, 'centrifuge', 'Adaptive centrifuge');
    const infoZh = page.getByRole('complementary', { name: '对象信息' });
    await infoZh.getByRole('button', { name: '启动程序', exact: true }).click();
    await expect(infoZh.getByLabel('关键观测有效性')).toHaveText(
      '当前关键观测有效',
    );
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: scenario.height });
    await page
      .getByRole('button', { name: 'Close object directory', exact: true })
      .click();
    const info = page.getByRole('complementary', { name: 'Object info' });
    await expect(info).toBeVisible();
    await page.locator('.lab-toolbar').hover({ position: { x: 20, y: 20 } });
    await page.mouse.wheel(0, 800);
    await expect
      .poll(() =>
        page.locator('.world-viewport').evaluate(async (element) => {
          const y = element.getBoundingClientRect().y;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          return Math.abs(element.getBoundingClientRect().y - y) < 0.01;
        }),
      )
      .toBe(true);
    const geometry = await exposedScene(page, info);
    await expect.poll(() => colors(page)).toBeGreaterThan(20);
    const start = info.getByRole('button', {
      name: 'Start centrifuge',
      exact: true,
    });
    const stop = info.getByRole('button', {
      name: 'Stop centrifuge',
      exact: true,
    });
    const input = info.getByLabel('Target speed (rpm)');
    for (const control of [start, stop, input])
      await expect(control).toBeEnabled();
    const bar = await rectangle(start.locator('..'));
    writeFileSync(
      join(evidence, `adaptive-${scenario.stem}-observed.json`),
      JSON.stringify(
        {
          viewport: page.viewportSize(),
          labName: scenario.labName,
          ...geometry,
          actionBar: bar,
          operations: await rectangle(
            info.getByRole('tab', { name: 'Operations', exact: true }),
          ),
          speed: await rectangle(
            info
              .getByRole('region', { name: 'Observed speed' })
              .locator('.observation-value'),
          ),
          temperature: await rectangle(
            info
              .getByRole('region', { name: 'Reported temperature' })
              .locator('.observation-value'),
          ),
        },
        null,
        2,
      ),
    );
    for (const action of [start, stop]) {
      const box = await rectangle(action);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height).toBeLessThanOrEqual(
        geometry.info.y + geometry.info.height + 1,
      );
    }
    for (const control of [
      info.getByRole('tab', { name: 'Operations', exact: true }),
      info
        .getByRole('region', { name: 'Observed speed' })
        .locator('.observation-value'),
      info
        .getByRole('region', { name: 'Reported temperature' })
        .locator('.observation-value'),
      info
        .getByRole('region', { name: 'Observed speed' })
        .locator('.observation-status'),
      info
        .getByRole('region', { name: 'Reported temperature' })
        .locator('.observation-status'),
    ]) {
      const box = await rectangle(control);
      expect(box.y).toBeGreaterThanOrEqual(geometry.info.y);
      expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
    }
    await input.focus();
    await expect(input).toBeFocused();
    const afterFocus = await rectangle(start);
    expect(afterFocus.y + afterFocus.height).toBeLessThanOrEqual(
      scenario.height - 40 + 1,
    );
    await info.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: join(evidence, `adaptive-${scenario.stem}.png`),
      animations: 'disabled',
    });
    writeFileSync(
      join(evidence, `adaptive-${scenario.stem}.json`),
      JSON.stringify(
        {
          viewport: page.viewportSize(),
          labName: scenario.labName,
          ...geometry,
          actionBar: bar,
          focusedParameter: true,
        },
        null,
        2,
      ),
    );
  });
}
