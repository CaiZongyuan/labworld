import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';

const require = createRequire(
  new URL('../../../package.json', import.meta.url),
);
const { chromium, expect } = require('@playwright/test');
const evidence = {
  version: 'v1',
  verifiedAt: new Date().toISOString(),
  checks: [],
  screenshots: [],
  errors: [],
  apiRequests: [],
  canvas: {},
  scope:
    'Isolated preview, memory simulator, synthetic history, real Three.js and repo UI components.',
};
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  deviceScaleFactor: 1,
});
page.on('pageerror', (error) => evidence.errors.push(error.message));
page.on('request', (request) => {
  if (new URL(request.url()).pathname.startsWith('/api/'))
    evidence.apiRequests.push(request.url());
});
const screenshot = async (name, fullPage = true) => {
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: new URL(`evidence/${name}.png`, import.meta.url).pathname,
    fullPage,
  });
  evidence.screenshots.push(name);
};
const check = async (name, action) => {
  await action();
  evidence.checks.push({ name, status: 'pass' });
  console.log(`PASS ${name}`);
};
const detail = () => page.locator('.device-dialog');
const close = () =>
  page.getByRole('button', { name: '关闭设备详情', exact: true }).click();
const navigate = async (name) => {
  const nav = page.getByRole('navigation', {
    name: (await page.viewportSize().width) > 760 ? '实验室导航' : '移动端视图',
    exact: true,
  });
  await nav.getByRole('button', { name, exact: true }).click();
};
const scenario = (value) =>
  page.getByLabel('预览场景', { exact: true }).selectOption(value);
const pixels = () =>
  page.locator('.space-canvas > canvas').evaluate((canvas) => {
    const copy = document.createElement('canvas');
    copy.width = 128;
    copy.height = 128;
    const context = copy.getContext('2d');
    context.drawImage(canvas, 0, 0, 128, 128);
    const data = context.getImageData(0, 0, 128, 128).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4)
      colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
    return { colors: colors.size, image: copy.toDataURL() };
  });

try {
  await page.goto('http://127.0.0.1:5196/prototype/lab-operations');
  await check(
    'Overview, device images and independent attention states',
    async () => {
      await expect(
        page.getByRole('heading', { name: '运行总览', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.device-table tbody tr')).toHaveCount(7);
      await expect(page.locator('.attention-item')).toHaveCount(2);
      assert(
        await page
          .locator('img')
          .evaluateAll((images) =>
            images.every((image) => image.complete && image.naturalWidth > 0),
          ),
      );
      assert(
        !(await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )),
      );
      await screenshot('overview-desktop');
    },
  );
  await check('Search and area filters', async () => {
    await page.getByLabel('搜索设备', { exact: true }).fill('TS-02');
    await expect(page.locator('.device-table tbody tr')).toHaveCount(1);
    await page.getByLabel('搜索设备', { exact: true }).fill('');
    await page.getByLabel('筛选区域', { exact: true }).selectOption('准备区');
    await expect(page.locator('.device-table tbody tr')).toHaveCount(3);
    await page.getByLabel('筛选区域', { exact: true }).selectOption('all');
  });
  await check(
    'Expired observation, drawer framing and explicit source recovery',
    async () => {
      await page
        .getByRole('button', { name: '查看温度传感器 B', exact: true })
        .click();
      await expect(
        detail().getByText('历史值 · 已过期', { exact: true }),
      ).toBeVisible();
      const rect = await detail().boundingBox();
      assert.equal(rect.y, 0);
      assert.equal(rect.x + rect.width, 1440);
      await screenshot('detail-desktop', false);
      await detail()
        .getByRole('button', { name: '重新启动程序', exact: true })
        .click();
      await expect(
        detail().getByText('命令已接受 · 等待设备确认', { exact: true }),
      ).toBeVisible();
      await expect(
        detail().locator('.detail-readings > div:first-child > strong'),
      ).toContainText('22.8');
      await expect(
        detail().getByText('执行成功 · 已收到新观测', { exact: true }),
      ).toBeVisible();
      await expect(
        detail().getByText('持续采样', { exact: true }),
      ).toBeVisible();
      await close();
      await expect(page.locator('.attention-item')).toHaveCount(1);
    },
  );
  await check(
    'Restart keeps interrupted result; a new task completes independently',
    async () => {
      await page
        .getByRole('button', { name: '查看离心机 B', exact: true })
        .click();
      await detail()
        .getByRole('button', { name: '启动新程序', exact: true })
        .click();
      await expect(
        detail().getByText('执行成功 · 已收到新观测', { exact: true }),
      ).toBeVisible();
      await expect(
        detail().getByText('结果：中断', { exact: true }),
      ).toBeVisible();
      await detail().getByLabel('转速 (rpm)', { exact: true }).fill('500');
      await detail().getByLabel('温度 (°C)', { exact: true }).fill('23');
      await detail().getByLabel('时长 (s)', { exact: true }).fill('6');
      await detail()
        .getByRole('button', { name: '启动任务', exact: true })
        .click();
      await expect(
        detail().getByText('结果：已完成', { exact: true }),
      ).toBeVisible({ timeout: 14000 });
      await detail()
        .getByRole('tab', { name: '运行记录', exact: true })
        .click();
      await expect(
        detail().getByText('离心任务完成', { exact: true }),
      ).toBeVisible();
      await expect(
        detail().getByText('离心任务中断', { exact: true }),
      ).toBeVisible();
      await close();
    },
  );
  await check('Task cancellation ends after deceleration', async () => {
    await page
      .getByRole('button', { name: '查看离心机 A', exact: true })
      .click();
    await detail()
      .getByRole('button', { name: '停止任务', exact: true })
      .click();
    const confirm = page.getByRole('dialog', {
      name: '停止当前离心任务？',
      exact: true,
    });
    await expect(confirm).toBeVisible();
    await confirm
      .getByRole('button', { name: '停止任务', exact: true })
      .click();
    await expect(
      detail().getByText('结果：已取消', { exact: true }),
    ).toBeVisible({ timeout: 8000 });
    await close();
  });
  await check(
    'Light commands separate acceptance from reported values',
    async () => {
      await page
        .getByRole('button', { name: '查看工作照明 A', exact: true })
        .click();
      const value = detail().locator(
        '.detail-readings > div:first-child > strong',
      );
      await expect(value).toContainText('80');
      await detail().getByRole('switch', { name: '电源', exact: true }).click();
      await expect(
        detail().getByText('命令已接受 · 等待设备确认', { exact: true }),
      ).toBeVisible();
      await expect(value).toContainText('80');
      await expect(
        detail().getByText('执行成功 · 已收到新观测', { exact: true }),
      ).toBeVisible();
      await expect(value).toHaveText('0%');
      await detail().getByRole('switch', { name: '电源', exact: true }).click();
      await expect(
        detail().getByText('执行成功 · 已收到新观测', { exact: true }),
      ).toBeVisible();
      await detail().getByLabel('目标亮度', { exact: true }).focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await detail()
        .getByRole('button', { name: '应用亮度', exact: true })
        .click();
      await expect(value).toHaveText('1%');
      await close();
    },
  );
  await check('Rejected operation preserves actual observation', async () => {
    await scenario('failed');
    await page
      .getByRole('button', { name: '查看工作照明 A', exact: true })
      .click();
    const before = await detail()
      .locator('.detail-readings > div:first-child > strong')
      .innerText();
    await detail().getByRole('switch', { name: '电源', exact: true }).click();
    await expect(
      detail().getByText('命令执行失败', { exact: true }),
    ).toBeVisible();
    assert.equal(
      await detail()
        .locator('.detail-readings > div:first-child > strong')
        .innerText(),
      before,
    );
    await screenshot('operation-failed', false);
    await close();
    await scenario('normal');
  });
  await check('Records, operator provenance and CSV export', async () => {
    await navigate('运行记录');
    await page.getByRole('tab', { name: '命令', exact: true }).click();
    await page
      .getByLabel('记录设备筛选', { exact: true })
      .selectOption('LT-01');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出当前记录', exact: true }).click(),
    ]);
    assert(download.suggestedFilename().endsWith('.csv'));
    const csv = await readFile(await download.path(), 'utf8');
    assert(csv.includes('LT-01'));
    assert(csv.includes('林研究员'));
    assert(!csv.includes('CF-01'));
    await screenshot('records-desktop');
    await navigate('运行总览');
  });
  await check(
    'Offline snapshot, read-only controls and reconnect',
    async () => {
      await scenario('offline');
      await page
        .getByRole('button', { name: '查看工作照明 A', exact: true })
        .click();
      await expect(
        detail().getByRole('switch', { name: '电源', exact: true }),
      ).toBeDisabled();
      await close();
      const snapshot = await page.locator('.device-table').innerText();
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('.device-table').innerText(), snapshot);
      await screenshot('offline-desktop');
      await page.getByRole('button', { name: '重新连接', exact: true }).click();
      await expect(page.locator('.heading-actions')).toContainText('实时同步');
    },
  );
  await check('Empty, loading, and invalid identity states', async () => {
    await scenario('empty');
    await expect(
      page.getByRole('heading', { name: '实验室里还没有设备', exact: true }),
    ).toBeVisible();
    await screenshot('empty-desktop');
    await page
      .getByRole('button', { name: '打开研发实验室', exact: false })
      .click();
    await scenario('loading');
    await expect(
      page.getByLabel('实验室加载中', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '刷新世界快照', exact: true })
      .click();
    await scenario('denied');
    await expect(
      page.getByRole('heading', { name: '当前身份已失效', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '重新登录', exact: true }).click();
  });
  await check('Dark theme and real-object unknown state', async () => {
    await page
      .locator('.shell-header')
      .getByRole('button', { name: '切换深色主题', exact: true })
      .click();
    await screenshot('overview-dark');
    await page
      .getByRole('button', { name: '查看环境探头 C', exact: true })
      .click();
    await expect(
      detail().getByText('尚无状态来源', { exact: true }),
    ).toBeVisible();
    await expect(detail().getByText('真实对象', { exact: true })).toBeVisible();
    await close();
    await page
      .locator('.shell-header')
      .getByRole('button', { name: '切换浅色主题', exact: true })
      .click();
  });
  await check(
    'Mobile 390px and 320px text fit, controls and drawer geometry',
    async () => {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert(
          !(await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          )),
        );
        await screenshot(`overview-${width}`);
        await page
          .getByRole('button', { name: '查看离心机 B', exact: true })
          .click();
        const rect = await detail().boundingBox();
        assert.equal(rect.x, 0);
        assert.equal(rect.width, width);
        assert.equal(rect.y, 0);
        assert(
          await detail().evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        );
        await screenshot(`detail-${width}`, false);
        await close();
      }
      await page.setViewportSize({ width: 1440, height: 1050 });
    },
  );
  await check(
    'Desktop WebGL pixels, motion, camera controls, labels and selection',
    async () => {
      await page.getByRole('button', { name: '重置预览', exact: true }).click();
      await navigate('空间');
      await expect(page.locator('.space-canvas > canvas')).toBeVisible();
      await page.waitForTimeout(400);
      const first = await pixels();
      assert(first.colors > 16);
      await page.waitForTimeout(500);
      const second = await pixels();
      assert.notEqual(first.image, second.image);
      evidence.canvas.desktop = { colors: first.colors, moving: true };
      const boxes = await page
        .locator('.space-device-label')
        .evaluateAll((labels) =>
          labels.map((label) => {
            const r = label.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          }),
        );
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          assert(
            !(
              boxes[i].x < boxes[j].right &&
              boxes[i].right > boxes[j].x &&
              boxes[i].y < boxes[j].bottom &&
              boxes[i].bottom > boxes[j].y
            ),
            'Device labels overlap',
          );
      await screenshot('space-desktop');
      const canvas = page.locator('.space-canvas > canvas'),
        rect = await canvas.boundingBox();
      await canvas.click({
        position: { x: rect.width * 0.54, y: rect.height * 0.47 },
      });
      await expect(detail()).toBeVisible();
      await close();
      await page
        .getByRole('button', { name: '在空间中查看温度传感器 B', exact: true })
        .click();
      await expect(detail()).toBeVisible();
      await close();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        rect.x + rect.width / 2 + 90,
        rect.y + rect.height / 2 + 30,
        { steps: 8 },
      );
      await page.mouse.up();
      await page.getByRole('button', { name: '放大', exact: true }).click();
      await page.getByRole('button', { name: '缩小', exact: true }).click();
      await page
        .getByRole('button', { name: '适配整个实验室', exact: true })
        .click();
    },
  );
  await check('Mobile WebGL framing, pixels and device selection', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const result = await pixels();
    assert(result.colors > 16);
    const rect = await page.locator('.space-canvas > canvas').boundingBox();
    assert.equal(rect.width, 390);
    assert(rect.height >= 400);
    assert(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )),
    );
    evidence.canvas.mobile = {
      colors: result.colors,
      width: rect.width,
      height: rect.height,
    };
    await screenshot('space-mobile');
    await page
      .locator('.space-device-strip')
      .getByRole('button', { name: '离心机 A', exact: false })
      .click();
    await expect(detail()).toBeVisible();
    await close();
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page
      .locator('.shell-header')
      .getByRole('button', { name: '切换深色主题', exact: true })
      .click();
    await screenshot('space-dark');
  });
  await check('Preview isolation and browser health', async () => {
    assert.deepEqual(evidence.apiRequests, []);
    assert.deepEqual(evidence.errors, []);
  });
  evidence.status = 'pass';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = String(error);
  console.error(error);
  await screenshot('verification-failure', false);
  process.exitCode = 1;
} finally {
  await writeFile(
    new URL('evidence/verification.json', import.meta.url),
    JSON.stringify(evidence, null, 2),
  );
  await browser.close();
}
