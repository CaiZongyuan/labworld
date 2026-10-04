import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const evidence = fileURLToPath(new URL('./evidence/', import.meta.url));
mkdirSync(evidence, { recursive: true });
const address =
  process.env.SPATIAL_PREVIEW_URL ??
  'http://127.0.0.1:5193/prototype/spatial-lab';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const requests = [];
const results = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('request', (request) => {
  if (new URL(request.url()).pathname.startsWith('/api/'))
    requests.push(request.url());
});
async function check(name, action) {
  await action();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
async function capture(name) {
  await page.screenshot({
    path: `${evidence}${name}.png`,
    animations: 'disabled',
    timeout: 20000,
  });
}
async function pixels() {
  return page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2');
    const values = new Uint8Array(
      gl.drawingBufferWidth * gl.drawingBufferHeight * 4,
    );
    gl.readPixels(
      0,
      0,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      values,
    );
    const colors = new Set();
    let hash = 2166136261;
    for (let i = 0; i < values.length; i += 64) {
      colors.add(
        `${values[i] >> 3}/${values[i + 1] >> 3}/${values[i + 2] >> 3}`,
      );
      hash = Math.imul(hash ^ values[i], 16777619) >>> 0;
    }
    return {
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      colors: colors.size,
      hash,
    };
  });
}
async function pick(name) {
  await page.getByRole('button', { name: '对象目录', exact: true }).click();
  await page
    .getByRole('button', { name: `目录选择 ${name}`, exact: true })
    .click();
  if (
    await page
      .getByRole('button', { name: '关闭对象目录', exact: true })
      .isVisible()
  )
    await page
      .getByRole('button', { name: '关闭对象目录', exact: true })
      .click();
}
async function noOverflow() {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
}
async function noLabelOverlaps() {
  const overlaps = await page
    .locator('.scene-label:visible')
    .evaluateAll((labels) => {
      const rects = labels.map((label) => label.getBoundingClientRect());
      return rects.some((a, i) =>
        rects.some(
          (b, j) =>
            j > i &&
            a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top,
        ),
      );
    });
  assert.equal(overlaps, false);
}
try {
  await page.goto(address);
  await page
    .getByRole('button', { name: '选择 冷冻离心机 01', exact: true })
    .waitFor();
  await page.waitForTimeout(700);
  await check(
    'desktop scene renders real pixels and complete room',
    async () => {
      const sample = await pixels();
      assert.ok(sample.colors > 40, JSON.stringify(sample));
      results.push({ name: 'desktop pixels', ...sample });
      await noOverflow();
      await noLabelOverlaps();
      await capture('desktop-overview');
    },
  );
  await check('pointer orbit changes canvas pixels', async () => {
    const before = await pixels();
    const canvas = await page.locator('canvas').boundingBox();
    await page.mouse.move(
      canvas.x + canvas.width * 0.55,
      canvas.y + canvas.height * 0.55,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvas.x + canvas.width * 0.55 + 100,
      canvas.y + canvas.height * 0.55 + 35,
      { steps: 8 },
    );
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.notEqual((await pixels()).hash, before.hash);
    await page.getByRole('button', { name: '恢复全景', exact: true }).click();
    await page.waitForTimeout(500);
  });
  await check('scene selection opens contextual controls', async () => {
    await page
      .getByRole('button', { name: '选择 冷冻离心机 01', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', { name: '设备操作面板' }),
    ).toBeVisible();
    await expect(page.getByLabel('目标转速 · rpm')).toHaveValue('6000');
    await page.waitForTimeout(400);
    await noLabelOverlaps();
    await capture('desktop-device');
  });
  await check(
    'task can be cancelled and second centrifuge stays independent',
    async () => {
      await page
        .getByRole('button', { name: '启动任务', exact: true })
        .filter({ visible: true })
        .click();
      await expect(
        page
          .getByRole('complementary', { name: '设备操作面板' })
          .getByText('准备中', { exact: true })
          .first(),
      ).toBeVisible();
      await page.waitForTimeout(350);
      await page
        .getByRole('button', { name: '停止', exact: true })
        .filter({ visible: true })
        .click();
      await expect(
        page.getByText('任务已取消 · 设备已空闲', { exact: true }),
      ).toBeVisible();
      await capture('task-cancelled');
      await pick('冷冻离心机 02');
      await expect(
        page.locator('.live-readings .reading').first().locator('strong'),
      ).toHaveText('0');
      await expect(page.getByText('当前任务', { exact: true })).toHaveCount(1);
    },
  );
  await check(
    'natural completion starts timing after targets are reached',
    async () => {
      await page.getByLabel('模拟时间速度').selectOption('1');
      await page.getByLabel('目标转速 · rpm').fill('500');
      await page.getByLabel('目标温度 · °C').fill('22.5');
      await page.getByLabel('持续时间 · min').fill('0.1');
      await page
        .getByRole('button', { name: '启动任务', exact: true })
        .filter({ visible: true })
        .click();
      await expect(
        page
          .getByRole('complementary', { name: '设备操作面板' })
          .getByText('运行中', { exact: true })
          .first(),
      ).toBeVisible();
      await capture('task-running');
      await expect(
        page.getByText('任务已完成 · 设备已空闲', { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await capture('task-completed');
    },
  );
  await check('offline state freezes observations and reconnects', async () => {
    await pick('环境温度传感器');
    await page.getByLabel('预览场景').selectOption('offline');
    const last = await page.locator('.live-readings strong').innerText();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.live-readings strong').innerText(), last);
    await expect(
      page.getByText('数据过期', { exact: true }).first(),
    ).toBeVisible();
    await capture('disconnected');
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  });
  await check('light controls change state and brightness', async () => {
    await pick('工作照明');
    await page.getByRole('switch', { name: '工作照明开关' }).click();
    await expect(
      page.getByRole('switch', { name: '工作照明开关' }),
    ).not.toBeChecked();
    await expect(page.locator('.reading strong')).toHaveText('0');
    await page.getByRole('switch', { name: '工作照明开关' }).click();
    await page.getByLabel('目标亮度').fill('42');
    await expect(page.locator('.reading strong')).toHaveText('42');
  });
  await check(
    'layout changes preserve registered location and allow conflict recovery',
    async () => {
      await pick('冷冻离心机 01');
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByLabel('X · m').fill('-2.1');
      await expect(
        page.getByText('登记位置：制备台 A', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText('已保存', { exact: true })).toBeVisible();
      await page.getByLabel('预览场景').selectOption('conflict');
      await capture('save-conflict');
      await page
        .getByRole('button', { name: '保留草稿重试', exact: true })
        .click();
      await expect(page.getByLabel('X · m')).toHaveValue('-2.1');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: '运行', exact: true }).click();
    },
  );
  await check('readonly identity prevents commands', async () => {
    await page.getByLabel('预览场景').selectOption('readonly');
    await expect(
      page
        .getByRole('button', { name: '再次启动', exact: true })
        .filter({ visible: true }),
    ).toBeDisabled();
    await page.getByLabel('预览场景').selectOption('normal');
  });
  await check('failure and loading states remain inspectable', async () => {
    await page.getByLabel('预览场景').selectOption('failure');
    await expect(
      page.getByText('设备程序中断，本次任务未完成。', { exact: true }),
    ).toBeVisible();
    await capture('device-failure');
    await page.getByLabel('预览场景').selectOption('loading');
    await expect(
      page.getByText('正在加载实验室', { exact: true }),
    ).toBeVisible();
    await capture('loading');
    await page.getByLabel('预览场景').selectOption('normal');
  });
  await check('empty laboratory can register its first object', async () => {
    await page.getByLabel('预览场景').selectOption('empty');
    await capture('empty');
    await page
      .getByRole('button', { name: '登记第一个对象', exact: true })
      .click();
    await page.getByLabel('对象名称').fill('新增离心机');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '登记对象', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '新增离心机', exact: true }),
    ).toBeVisible();
  });
  await check(
    'asset images render and additions enter the same laboratory',
    async () => {
      await page.getByRole('button', { name: '资产库', exact: true }).click();
      await expect(page.locator('.asset-item img')).toHaveCount(5);
      assert.equal(
        await page
          .locator('.asset-item img')
          .evaluateAll((images) =>
            images.every((image) => image.complete && image.naturalWidth > 0),
          ),
        true,
      );
      await capture('asset-library');
      await page
        .locator('.asset-item')
        .filter({
          has: page.getByRole('heading', {
            name: '环境温度传感器',
            exact: true,
          }),
        })
        .getByRole('button', { name: '加入实验室', exact: true })
        .click();
      await page.getByLabel('对象名称').fill('新传感器');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '登记对象', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: '新传感器', exact: true }),
      ).toBeVisible();
    },
  );
  await check(
    '390px controls remain accessible with a visible canvas',
    async () => {
      await page.getByRole('button', { name: '重置', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(500);
      await noOverflow();
      await noLabelOverlaps();
      assert.ok((await pixels()).colors > 40);
      await capture('mobile-overview');
      await pick('冷冻离心机 01');
      const button = page
        .getByRole('button', { name: '启动任务', exact: true })
        .filter({ visible: true });
      await expect(button).toBeInViewport();
      await capture('mobile-device');
      await button.click();
      await page
        .getByRole('button', { name: '停止', exact: true })
        .filter({ visible: true })
        .click();
      await expect(
        page.getByText('任务已取消 · 设备已空闲', { exact: true }),
      ).toBeVisible();
      await noOverflow();
    },
  );
  await check(
    '320px dark view fits without overlapping labels or controls',
    async () => {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.getByRole('button', { name: '切换暗色', exact: true }).click();
      await page.waitForTimeout(500);
      await noOverflow();
      await noLabelOverlaps();
      assert.ok((await pixels()).colors > 40);
      await capture('mobile-320-dark');
      await expect(
        page
          .getByRole('button', { name: '再次启动', exact: true })
          .filter({ visible: true }),
      ).toBeInViewport();
    },
  );
  await check('desktop dark view and history drawer render', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(500);
    await capture('desktop-dark');
    await page.getByRole('button', { name: '运行记录', exact: false }).click();
    await expect(
      page.getByRole('region', { name: '运行记录', exact: true }),
    ).toBeVisible();
    await capture('history');
  });
  await check(
    'preview stays isolated and reports no browser errors',
    async () => {
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
    },
  );
  writeFileSync(
    `${evidence}inspection.json`,
    JSON.stringify(
      {
        address,
        results,
        errors,
        applicationRequests: requests,
        renderer: 'Chromium / ANGLE SwiftShader',
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(
    `Completed ${results.filter((item) => item.passed).length} checks`,
  );
} catch (error) {
  writeFileSync(
    `${evidence}inspection-failure.json`,
    JSON.stringify(
      { results, errors, applicationRequests: requests, error: String(error) },
      null,
      2,
    ),
  );
  await capture('inspection-failure').catch(() => {});
  throw error;
} finally {
  await browser.close();
}
