import { expectInitialSceneReady } from './initial-scene-ready';
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
  await expectInitialSceneReady(page.locator('.world-page'));
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

test('ready shared details support the accepted desktop and narrow viewports, keyboard and focus return', async ({
  page,
}) => {
  test.setTimeout(90000);
  await member(page, 'Shared details acceptance');
  await register(page, 'centrifuge', 'Ready centrifuge');
  await page
    .getByRole('complementary', { name: '对象信息' })
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await expect(page.getByLabel('关键观测有效性')).toHaveText(
    '当前关键观测有效',
  );
  const initialInfo = page.getByRole('complementary', { name: '对象信息' });
  await initialInfo.getByRole('tab', { name: '记录', exact: true }).click();
  const records = initialInfo.getByRole('tabpanel', {
    name: '记录',
    exact: true,
  });
  await expect(records.locator('.world-history-record').first()).toBeVisible();
  await initialInfo.getByRole('tab', { name: '操作', exact: true }).click();
  const results: unknown[] = [];
  for (const viewport of [
    { width: 1440, height: 1000, english: false },
    { width: 1920, height: 1080, english: false },
    { width: 390, height: 844, english: false },
    { width: 320, height: 844, english: true },
  ]) {
    if (viewport.english) {
      await page.getByRole('button', { name: 'English', exact: true }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
    }
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.emulateMedia({
      reducedMotion: viewport.width < 560 ? 'reduce' : 'no-preference',
    });
    const directory = page.locator('.lab-toolbar').getByRole('button', {
      name: /^(打开对象目录|关闭对象目录|Open object directory|Close object directory)$/,
    });
    if ((await directory.getAttribute('aria-expanded')) === 'true')
      await directory.click();
    const info = page.getByRole('complementary', {
      name: viewport.english ? 'Object info' : '对象信息',
    });
    await expect(info).toBeVisible();
    if (viewport.width < 560) {
      await page.locator('.lab-toolbar').hover({ position: { x: 20, y: 20 } });
      await page.mouse.wheel(0, 800);
      await expect
        .poll(() =>
          page.locator('.world-viewport').evaluate(async (element) => {
            const y = element.getBoundingClientRect().y;
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            );
            return Math.abs(element.getBoundingClientRect().y - y) < 0.01;
          }),
        )
        .toBe(true);
    }
    const scene = await rectangle(page.locator('.world-viewport canvas'));
    expect(scene.height).toBeGreaterThanOrEqual(180);
    await expect.poll(() => colors(page)).toBeGreaterThan(20);
    const start = info.getByRole('button', {
      name: viewport.english ? 'Start centrifuge' : '开始离心',
      exact: true,
    });
    const stop = info.getByRole('button', {
      name: viewport.english ? 'Stop centrifuge' : '停止离心',
      exact: true,
    });
    const input = info.getByLabel(
      viewport.english ? 'Target speed (rpm)' : '目标转速 (rpm)',
    );
    for (const action of [start, stop, input])
      await expect(action).toBeEnabled();
    const speed = info.getByRole('region', {
      name: viewport.english ? 'Observed speed' : '观测转速',
    });
    const temperature = info.getByRole('region', {
      name: viewport.english ? 'Reported temperature' : '观测温度',
    });
    await expect(speed.locator('.observation-value')).toHaveText('0 rpm');
    await expect(temperature.locator('.observation-value')).toHaveText(
      '22 degC',
    );
    const infoBox = await rectangle(info);
    const bar = await rectangle(start.locator('..'));
    if (viewport.width < 560) {
      await exposedScene(page, info);
      for (const control of [
        speed.locator('.observation-value'),
        speed.locator('.observation-status'),
        temperature.locator('.observation-value'),
        temperature.locator('.observation-status'),
      ]) {
        const box = await rectangle(control);
        expect(box.y).toBeGreaterThanOrEqual(infoBox.y);
        expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
      }
      for (const action of [start, stop])
        expect((await rectangle(action)).height).toBeGreaterThanOrEqual(44);
      expect(bar.y + bar.height).toBeLessThanOrEqual(
        infoBox.y + infoBox.height + 1,
      );
    }
    await input.focus();
    await expect(input).toBeFocused();
    await info.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: join(
        evidence,
        `accepted-${viewport.width}-${viewport.english ? 'en-dark' : 'zh-light'}.png`,
      ),
      animations: 'disabled',
    });
    results.push({
      viewport,
      scene,
      inspector: infoBox,
      actionBar: bar,
      inputFocus: true,
    });
  }
  const info = page.getByRole('complementary', { name: 'Object info' });
  await info
    .getByRole('button', { name: 'Close object details', exact: true })
    .click();
  const open = page.getByRole('button', {
    name: 'Open object details',
    exact: true,
  });
  await open.click();
  await page.keyboard.press('Escape');
  await expect(info).toBeHidden();
  await expect(open).toBeFocused();
  writeFileSync(
    join(evidence, 'accepted-viewports.json'),
    JSON.stringify(
      { results, keyboardEscape: true, focusReturn: true },
      null,
      2,
    ),
  );
});
