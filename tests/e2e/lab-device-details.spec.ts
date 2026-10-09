import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabEntity } from '../../packages/sdk/src/index';
import { member } from './lab-foundation-support';

test.use({ locale: 'zh-CN' });
const evidence =
  process.env.LAB_DEVICE_DETAIL_EVIDENCE ??
  '.scratch/device-details/application';
mkdirSync(evidence, { recursive: true });

async function pixels(page: Page, stem: string) {
  const canvas = page.locator('canvas');
  const png = await canvas.screenshot({
    path: join(evidence, `${stem}-canvas.png`),
  });
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const capture = document.createElement('canvas');
    capture.width = image.width;
    capture.height = image.height;
    const context = capture.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const colors = new Set<string>();
    for (let i = 0; i < data.length; i += 16)
      colors.add(`${data[i] >> 4}:${data[i + 1] >> 4}:${data[i + 2] >> 4}`);
    return colors.size;
  }, png.toString('base64'));
}

async function rectangle(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function exposedScene(page: Page, info: Locator) {
  const canvas = page.locator('canvas');
  await expect
    .poll(async () => {
      const bounds = await canvas.boundingBox(),
        panelBounds = await info.boundingBox();
      if (!bounds || !panelBounds) return false;
      return page.viewportSize()!.width < 500
        ? bounds.height >= 180 && bounds.y + bounds.height <= panelBounds.y + 1
        : bounds.x + bounds.width <= panelBounds.x + 1;
    })
    .toBe(true);
  const box = await rectangle(canvas),
    panel = await rectangle(info);
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  const footer = await rectangle(page.locator('.lab-status'));
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(
    Math.min(footer.y, viewport.height),
  );
  if (viewport.width < 500) {
    expect(box.height).toBeGreaterThanOrEqual(180);
    expect(box.y + box.height).toBeLessThanOrEqual(panel.y + 1);
  } else {
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + 1);
  }
  const uncovered = await page.evaluate((bounds) => {
    const surface = document.querySelector('.world-viewport')!;
    return [0.2, 0.5, 0.8].flatMap((x) =>
      [0.2, 0.5, 0.8].map((y) =>
        surface.contains(
          document.elementFromPoint(
            bounds.x + bounds.width * x,
            bounds.y + bounds.height * y,
          ),
        ),
      ),
    );
  }, box);
  expect(uncovered).toEqual(Array(9).fill(true));
  return { box, uncovered };
}

async function captureFailure(page: Page, error: unknown, stem: string) {
  const assertionLocation =
    error instanceof Error
      ? error.stack?.match(
          /tests\/e2e\/lab-device-details\.spec\.ts:\d+:\d+/,
        )?.[0]
      : undefined;
  const geometry = page.isClosed()
    ? null
    : await page.evaluate(() => {
        const box = (element: Element | null) =>
          element?.getBoundingClientRect().toJSON() ?? null;
        return {
          canvas: box(document.querySelector('canvas')),
          info: box(document.querySelector('.world-inspector')),
          readings: [
            ...document.querySelectorAll(
              '.world-inspector .observation-summary',
            ),
          ].map((reading) => ({
            label: reading.getAttribute('aria-label'),
            value: box(reading.querySelector('.observation-value')),
            status: box(reading.querySelector('.observation-status')),
          })),
          actions: box(
            document.querySelector(
              '.centrifuge-panel > form > .centrifuge-actions',
            ),
          ),
        };
      });
  writeFileSync(
    join(evidence, `${stem}-failure.json`),
    JSON.stringify({ assertionLocation, geometry }, null, 2),
  );
  if (!page.isClosed())
    await page.screenshot({
      path: join(evidence, `${stem}-failure.png`),
      animations: 'disabled',
    });
}

async function select(page: Page, name: string, english = false) {
  const info = page.getByRole('complementary', {
    name: english ? 'Object info' : '对象信息',
  });
  const heading = info.getByRole('heading', { name, exact: true });
  if ((await info.isVisible()) && (await heading.isVisible())) return;
  if ((await info.isVisible()) && page.viewportSize()!.width < 500)
    await info
      .getByRole('button', {
        name: english ? 'Close object details' : '关闭对象信息',
        exact: true,
      })
      .click();
  const target = page.getByRole('button', {
    name: `${english ? 'Select' : '选择'} ${name}`,
    exact: true,
  });
  if (!(await target.isVisible()))
    await page
      .getByRole('button', {
        name: english ? 'Open object directory' : '打开对象目录',
        exact: true,
      })
      .click();
  await target.click();
  await expect(
    page
      .getByRole('complementary', {
        name: english ? 'Object info' : '对象信息',
      })
      .getByRole('heading', { name, exact: true }),
  ).toBeVisible();
}

test('normal shared details keep independent controls, backend results and usable viewports', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  const { agent } = await member(page);
  const get = async (path: string): Promise<LabEntity> => {
    const response = await agent.get(path);
    expect(response.status()).toBe(200);
    return response.json();
  };
  let restored: Page | undefined;
  try {
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('名称', { exact: true })
      .fill('Shared device details Lab');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Shared device details Lab',
        exact: true,
      }),
    ).toBeVisible();
    const labId = new URL(page.url()).searchParams.get('lab')!;
    const ids = new Map<string, string>();
    for (const [definition, name] of [
      ['centrifuge', 'Centrifuge A'],
      ['centrifuge', 'Centrifuge B'],
      ['light', 'Light A'],
      ['light', 'Light B'],
    ]) {
      await page.getByRole('button', { name: '登记对象', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
      await dialog.getByLabel('身份来源').selectOption('simulated');
      await dialog.getByLabel('名称', { exact: true }).fill(name);
      await dialog.getByRole('button', { name: '登记', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(
        page
          .getByRole('complementary', { name: '对象信息' })
          .getByRole('heading', { name, exact: true }),
      ).toBeVisible();
      ids.set(name, new URL(page.url()).searchParams.get('entity')!);
      await page.getByRole('button', { name: '启动程序', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '停止程序', exact: true }),
      ).toBeVisible();
      if (definition === 'centrifuge')
        await expect(page.getByLabel('关键观测有效性')).toHaveText(
          '当前关键观测有效',
          { timeout: 15000 },
        );
    }
    const path = (name: string) =>
      `/api/v1/lab/labs/${labId}/entities/${ids.get(name)}`;
    await select(page, 'Light A');
    await page.getByRole('switch', { name: '电源', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await get(path('Light A'))).observation?.properties.on.value,
      )
      .toBe(true);
    await page.getByLabel('目标亮度 (%)').fill('37');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await get(path('Light A'))).observation?.properties.brightness.value,
      )
      .toBe(37);
    await select(page, 'Light B');
    await page.getByLabel('目标亮度 (%)').fill('20');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await get(path('Light B'))).observation?.properties.brightness.value,
      )
      .toBe(20);
    await select(page, 'Light A');
    await expect(page.getByLabel('目标亮度 (%)')).toHaveValue('37');
    const agentWrite = await agent.post(`${path('Light A')}/actions`, {
      headers: { 'Idempotency-Key': `details-agent-${Date.now()}` },
      data: {
        capability: 'light.set_brightness',
        parameters: { brightness: 31 },
      },
    });
    expect(agentWrite.status()).toBe(202);
    await expect(page.getByRole('region', { name: '观测亮度' })).toContainText(
      '31 %',
    );
    await expect(page.getByLabel('目标亮度 (%)')).toHaveValue('37');

    await select(page, 'Centrifuge A');
    await page.getByLabel('目标转速 (rpm)').fill('15000');
    await page.getByLabel('目标温度 (degC)').fill('22');
    await page.getByLabel('任务时长 (s)').fill('30');
    await page.getByRole('button', { name: '开始离心', exact: true }).click();
    await expect
      .poll(async () => (await get(path('Centrifuge A'))).task?.status)
      .toBe('preparing');
    const preparingA = await get(path('Centrifuge A'));
    expect(preparingA.task?.elapsed_seconds).toBe(0);
    await select(page, 'Centrifuge B');
    await page.getByLabel('目标转速 (rpm)').fill('15000');
    await page.getByLabel('目标温度 (degC)').fill('22');
    await page.getByLabel('任务时长 (s)').fill('60');
    await page.getByRole('button', { name: '开始离心', exact: true }).click();
    await expect
      .poll(async () => (await get(path('Centrifuge B'))).task?.status, {
        timeout: 15000,
      })
      .toBe('running');
    const taskB = (await get(path('Centrifuge B'))).task!;
    expect(taskB.parameters).toEqual({
      rpm: 15000,
      temperature: 22,
      duration_seconds: 60,
    });
    await page.getByRole('button', { name: '停止离心', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '停止当前离心任务？' });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole('button', { name: '停止程序', exact: true }),
    ).toBeHidden();
    await dialog.getByRole('button', { name: '停止离心', exact: true }).click();
    await expect
      .poll(async () => (await get(path('Centrifuge B'))).task?.status)
      .toBe('decelerating');
    await expect
      .poll(async () => (await get(path('Centrifuge B'))).task_result?.status, {
        timeout: 15000,
      })
      .toBe('cancelled');
    const cancelled = await get(path('Centrifuge B'));
    const memberCopy = await (
      await page.request.get(path('Centrifuge B'))
    ).json();
    expect(memberCopy.task_result.id).toBe(cancelled.task_result!.id);
    expect(cancelled.observation?.properties.speed.value).toBe(0);
    const beforeClose = await get(path('Centrifuge A'));
    expect(['preparing', 'running']).toContain(beforeClose.task?.status);
    const storage = await page.context().storageState();
    await page.close();
    await expect
      .poll(async () => (await get(path('Centrifuge A'))).task_result?.status, {
        timeout: 60000,
      })
      .toBe('completed');
    const complete = await get(path('Centrifuge A'));
    expect(complete.task?.parameters).toEqual({
      rpm: 15000,
      temperature: 22,
      duration_seconds: 30,
    });
    expect(complete.task?.elapsed_seconds).toBeGreaterThanOrEqual(30);
    expect((await get(path('Centrifuge B'))).task_result!.id).toBe(
      cancelled.task_result!.id,
    );
    const context = await browser.newContext({
      storageState: storage,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    restored = await context.newPage();
    restored.on('pageerror', (error) => errors.push(error.name));
    await restored.goto(`/lab?lab=${labId}&entity=${ids.get('Centrifuge A')}`);
    await expect(
      restored.getByRole('region', { name: '离心任务' }),
    ).toContainText('已完成');

    const sourceStop = restored.getByRole('button', {
      name: '停止程序',
      exact: true,
    });
    await sourceStop.focus();
    await restored.keyboard.press('Enter');
    await expect(restored.getByRole('dialog')).toBeVisible();
    await restored.keyboard.press('Escape');
    await expect(restored.getByRole('dialog')).toBeHidden();
    await expect(sourceStop).toBeFocused();
    const operationsTab = restored.getByRole('tab', {
      name: '操作',
      exact: true,
    });
    await operationsTab.focus();
    await restored.keyboard.press('ArrowRight');
    await restored.keyboard.press('Enter');
    await expect(
      restored.getByRole('tab', { name: '记录', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await restored.keyboard.press('ArrowRight');
    await restored.keyboard.press('Enter');
    await expect(
      restored.getByRole('tab', { name: '详情', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await restored.keyboard.press('ArrowLeft');
    await restored.keyboard.press('ArrowLeft');
    await restored.keyboard.press('Enter');
    await expect(operationsTab).toHaveAttribute('aria-selected', 'true');
    await expect(
      restored.getByRole('region', { name: '观测阶段' }),
    ).toContainText('空闲');
    const oldResult = complete.task_result!.id;
    await restored
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    await restored
      .getByRole('dialog')
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    await expect
      .poll(async () => (await get(path('Centrifuge A'))).program_run?.status)
      .toBe('stopped');
    await expect(
      restored.getByRole('region', { name: '观测转速' }),
    ).toContainText('最后报告值');
    await restored
      .getByRole('button', { name: '启动程序', exact: true })
      .click();
    await expect
      .poll(async () => (await get(path('Centrifuge A'))).program_run?.id)
      .not.toBe(complete.program_run!.id);
    expect((await get(path('Centrifuge A'))).task_result!.id).toBe(oldResult);
    await expect(
      restored.getByRole('region', { name: '离心任务' }),
    ).toContainText('已完成');

    writeFileSync(
      join(evidence, 'functional.json'),
      JSON.stringify(
        {
          labId,
          entityIds: Object.fromEntries(ids),
          complete: complete.task,
          completedResult: oldResult,
          cancelled: cancelled.task,
          cancelledResult: cancelled.task_result,
          noBrowserTaskTermination: true,
          errors,
        },
        null,
        2,
      ),
    );
    const captures: unknown[] = [];
    for (const [width, language, theme] of [
      [1440, 'zh', 'light'],
      [1920, 'zh', 'light'],
      [390, 'zh', 'light'],
      [320, 'en', 'dark'],
    ] as const) {
      await restored.setViewportSize({
        width,
        height: width < 500 ? 844 : 1000,
      });
      if (language === 'en')
        await restored
          .getByRole('button', { name: 'English', exact: true })
          .click();
      if (theme === 'dark')
        await restored
          .getByRole('button', { name: 'Dark', exact: true })
          .click();
      await restored.emulateMedia({
        reducedMotion: width === 320 ? 'reduce' : 'no-preference',
      });
      const english = language === 'en';
      await select(restored, 'Centrifuge A', english);
      const info = restored.getByRole('complementary', {
        name: english ? 'Object info' : '对象信息',
      });
      await info.evaluate((element) => {
        element.scrollTop = 0;
      });
      const canvas = restored.locator('canvas');
      await expect(canvas).toBeVisible();
      const stem = `${width}-${language}-${theme}`;
      const scene = await exposedScene(restored, info);
      await expect
        .poll(async () => pixels(restored!, stem), { timeout: 30000 })
        .toBeGreaterThan(20);
      await restored.screenshot({ path: join(evidence, `${stem}.png`) });
      const canvasBox = await rectangle(canvas),
        infoBox = await rectangle(info);
      const viewport = restored.viewportSize()!;
      expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(
        viewport.height + 1,
      );
      expect(infoBox.y + infoBox.height).toBeLessThanOrEqual(
        viewport.height + 1,
      );
      expect(
        await restored.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      const start = info.getByRole('button', {
        name: english ? 'Start centrifuge' : '开始离心',
        exact: true,
      });
      const stop = info.getByRole('button', {
        name: english ? 'Stop centrifuge' : '停止离心',
        exact: true,
      });
      const targets = [];
      for (const action of [start, stop]) {
        const box = await rectangle(action);
        targets.push(box);
        if (width < 500) {
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.y).toBeGreaterThanOrEqual(infoBox.y);
          expect(box.y + box.height).toBeLessThanOrEqual(
            infoBox.y + infoBox.height + 1,
          );
        }
      }
      if (width < 500) {
        const actionBar = await rectangle(start.locator('..'));
        for (const control of [
          info.getByRole('tab', {
            name: english ? 'Operations' : '操作',
            exact: true,
          }),
          info
            .getByRole('region', {
              name: english ? 'Observed speed' : '观测转速',
            })
            .locator('.observation-value'),
          info
            .getByRole('region', {
              name: english ? 'Reported temperature' : '观测温度',
            })
            .locator('.observation-value'),
          info
            .getByRole('region', {
              name: english ? 'Observed speed' : '观测转速',
            })
            .locator('.observation-status'),
          info
            .getByRole('region', {
              name: english ? 'Reported temperature' : '观测温度',
            })
            .locator('.observation-status'),
        ]) {
          const box = await rectangle(control);
          expect(box.y).toBeGreaterThanOrEqual(infoBox.y);
          expect(box.y + box.height).toBeLessThanOrEqual(actionBar.y);
        }
        await info
          .getByLabel(english ? 'Target speed (rpm)' : '目标转速 (rpm)')
          .focus();
        await expect(
          info.getByLabel(english ? 'Target speed (rpm)' : '目标转速 (rpm)'),
        ).toBeFocused();
        const afterScroll = await rectangle(start);
        expect(afterScroll.y + afterScroll.height).toBeLessThanOrEqual(
          infoBox.y + infoBox.height + 1,
        );
      }
      captures.push({
        width,
        language,
        theme,
        canvas: canvasBox,
        canvasCoveredByDetail: false,
        uncoveredScenePoints: scene.uncovered,
        info: infoBox,
        targets,
        reducedMotion: width === 320,
        keyboardTabsAndFocusReturn: true,
      });
    }
    const defaultScene = [];
    for (const width of [320, 390, 1440]) {
      await restored.setViewportSize({
        width,
        height: width < 500 ? 844 : 1000,
      });
      if (width === 390) {
        await restored
          .getByRole('button', { name: '简体中文', exact: true })
          .click();
        await restored
          .getByRole('button', { name: '亮色', exact: true })
          .click();
      }
      await restored.goto(`/lab?lab=${labId}`);
      await expect(
        restored.getByRole('complementary', {
          name: width === 320 ? 'Object info' : '对象信息',
        }),
      ).toBeHidden();
      expect(new URL(restored.url()).searchParams.has('entity')).toBe(false);
      const canvas = restored.locator('canvas');
      await expect(canvas).toBeVisible();
      const stem = `default-${width}`;
      await expect
        .poll(async () => pixels(restored!, stem))
        .toBeGreaterThan(20);
      const box = await rectangle(canvas);
      expect(box.width).toBeGreaterThan(100);
      expect(box.y + box.height).toBeLessThanOrEqual(
        restored.viewportSize()!.height + 1,
      );
      await restored.screenshot({ path: join(evidence, `${stem}.png`) });
      defaultScene.push({
        width,
        canvas: box,
        nonblank: true,
        noSelection: true,
      });
    }
    writeFileSync(
      join(evidence, 'visual.json'),
      JSON.stringify({ captures, defaultScene, nonblank: true }, null, 2),
    );
    expect(errors).toEqual([]);
    await context.close();
  } catch (error) {
    const activePage = restored ?? page;
    await captureFailure(activePage, error, 'functional');
    throw error;
  } finally {
    await restored?.context().close();
    await agent.dispose();
  }
});

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
    const { agent } = await member(page);
    try {
      await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('名称', { exact: true }).fill(scenario.labName);
      await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue(
        scenario.labName,
      );
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await page.getByRole('button', { name: '登记对象', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('定义版本').selectOption('centrifuge@1.0');
      await dialog.getByLabel('身份来源').selectOption('simulated');
      await dialog
        .getByLabel('名称', { exact: true })
        .fill('Adaptive centrifuge');
      await dialog.getByRole('button', { name: '登记', exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.getByRole('button', { name: '启动程序', exact: true }).click();
      await expect(page.getByLabel('关键观测有效性')).toHaveText(
        '当前关键观测有效',
      );
      await page.getByRole('button', { name: 'English', exact: true }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 320, height: scenario.height });
      await select(page, 'Adaptive centrifuge', true);
      await page.locator('.lab-toolbar').hover({ position: { x: 20, y: 20 } });
      await page.mouse.wheel(0, 800);
      const info = page.getByRole('complementary', { name: 'Object info' });
      const scene = await exposedScene(page, info);
      await expect
        .poll(async () => pixels(page, `adaptive-${scenario.stem}`))
        .toBeGreaterThan(20);
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
      const infoBox = await rectangle(info);
      for (const action of [start, stop]) {
        const box = await rectangle(action);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.y + box.height).toBeLessThanOrEqual(
          infoBox.y + infoBox.height + 1,
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
        expect(box.y).toBeGreaterThanOrEqual(infoBox.y);
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
            scene,
            info: infoBox,
            actionBar: bar,
            focusedParameter: true,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await captureFailure(page, error, `adaptive-${scenario.stem}`);
      throw error;
    } finally {
      await agent.dispose();
    }
  });
}

test('ready mobile details expose enabled controls and key observations', async ({
  page,
}) => {
  const { agent } = await member(page);
  try {
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称', { exact: true }).fill('Ready device Lab');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('button', { name: '登记对象', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('定义版本').selectOption('centrifuge@1.0');
    await dialog.getByLabel('身份来源').selectOption('simulated');
    await dialog.getByLabel('名称', { exact: true }).fill('Ready centrifuge');
    await dialog.getByRole('button', { name: '登记', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: '启动程序', exact: true }).click();
    await expect(page.getByLabel('关键观测有效性')).toHaveText(
      '当前关键观测有效',
    );
    const captures = [];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const english = width === 320;
      if (english) {
        await page
          .getByRole('button', { name: 'English', exact: true })
          .click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      await page.emulateMedia({
        reducedMotion: english ? 'reduce' : 'no-preference',
      });
      await select(page, 'Ready centrifuge', english);
      const info = page.getByRole('complementary', {
        name: english ? 'Object info' : '对象信息',
      });
      const operations = info.getByRole('tab', {
        name: english ? 'Operations' : '操作',
        exact: true,
      });
      const start = info.getByRole('button', {
        name: english ? 'Start centrifuge' : '开始离心',
        exact: true,
      });
      const stop = info.getByRole('button', {
        name: english ? 'Stop centrifuge' : '停止离心',
        exact: true,
      });
      const input = info.getByLabel(
        english ? 'Target speed (rpm)' : '目标转速 (rpm)',
      );
      for (const control of [operations, start, stop, input])
        await expect(control).toBeEnabled();
      await expect(info).toBeVisible();
      const scene = await exposedScene(page, info);
      await expect
        .poll(async () => pixels(page, `ready-${width}-scene`))
        .toBeGreaterThan(20);
      const canvas = page.locator('canvas');
      const beforeOrbit = await canvas.screenshot();
      const dragX = scene.box.x + scene.box.width * 0.85,
        dragY = scene.box.y + scene.box.height * 0.8;
      await page.mouse.move(dragX, dragY);
      await page.mouse.down();
      await page.mouse.move(dragX - 40, dragY - 20, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(async () => !(await canvas.screenshot()).equals(beforeOrbit))
        .toBe(true);
      await input.focus();
      await expect(input).toBeFocused();
      const startBox = await rectangle(start),
        stopBox = await rectangle(stop);
      expect(startBox.height).toBeGreaterThanOrEqual(44);
      expect(stopBox.height).toBeGreaterThanOrEqual(44);
      expect(startBox.width).toBe(stopBox.width);
      await info.evaluate((element) => {
        element.scrollTop = 0;
      });
      await operations.focus();
      await expect(operations).toBeFocused();
      const infoBox = await rectangle(info);
      const actionBar = await rectangle(start.locator('..'));
      for (const control of [
        operations,
        info
          .getByRole('region', {
            name: english ? 'Observed speed' : '观测转速',
          })
          .locator('.observation-value'),
        info
          .getByRole('region', {
            name: english ? 'Reported temperature' : '观测温度',
          })
          .locator('.observation-value'),
        info
          .getByRole('region', {
            name: english ? 'Observed speed' : '观测转速',
          })
          .locator('.observation-status'),
        info
          .getByRole('region', {
            name: english ? 'Reported temperature' : '观测温度',
          })
          .locator('.observation-status'),
      ]) {
        const box = await rectangle(control);
        expect(box.y).toBeGreaterThanOrEqual(infoBox.y);
        expect(box.y + box.height).toBeLessThanOrEqual(actionBar.y);
      }
      await page.screenshot({
        path: join(evidence, `ready-${width}.png`),
        animations: 'disabled',
      });
      captures.push({
        width,
        start: startBox,
        stop: stopBox,
        info: infoBox,
        scene: scene.box,
        uncoveredScenePoints: scene.uncovered,
        sceneOperable: true,
        operationsEnabled: await operations.isEnabled(),
        startEnabled: await start.isEnabled(),
        stopEnabled: await stop.isEnabled(),
        inputEnabled: await input.isEnabled(),
        startOpacity: await start.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
        stopOpacity: await stop.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
        focusedParameterAndTab: true,
      });
    }
    writeFileSync(
      join(evidence, 'ready-state.json'),
      JSON.stringify({ captures }, null, 2),
    );
  } catch (error) {
    await captureFailure(page, error, 'ready');
    throw error;
  } finally {
    await agent.dispose();
  }
});
