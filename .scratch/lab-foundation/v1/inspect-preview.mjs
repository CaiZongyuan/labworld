// Browser inspection of this disposable experience, not production acceptance tests.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('./', import.meta.url));
const url = 'http://127.0.0.1:5191/prototype/lab-foundation';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  locale: 'zh-CN',
});
const page = await context.newPage();
const errors = [];
const checks = [];
const warnings = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});
page.setDefaultTimeout(20000);
const state = () =>
  page.evaluate(() => {
    const s = window.__FOUNDATION_PREVIEW__.snapshot();
    return {
      layout: s.layout,
      devices: s.devices,
      tasks: s.tasks,
      meta: s.meta,
      events: s.events,
      assets: s.assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name })),
    };
  });
const ready = async () => {
  await page.waitForFunction(
    () => window.__FOUNDATION_PREVIEW__?.snapshot().meta.ready,
  );
  await page.waitForSelector('canvas[aria-label]');
  await page.getByRole('button', { name: '开始任务', exact: true }).waitFor();
};
const shot = (name) =>
  page.screenshot({ path: `${here}evidence/${name}.png`, fullPage: true });
const select = (id) =>
  page.locator('.entity-row').filter({ hasText: id }).click();
const phase = (id, phase) =>
  page.waitForFunction(
    ({ id, phase }) =>
      window.__FOUNDATION_PREVIEW__.snapshot().devices[id]?.phase === phase,
    { id, phase },
  );
const painted = () =>
  page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas[aria-label]');
      if (!canvas) return false;
      const gl = canvas.getContext('webgl2');
      if (!gl || !canvas.width || !canvas.height) return false;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 256)
        colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      return colors.size > 30;
    },
    null,
    { polling: 500 },
  );
async function check(name, fn) {
  await fn();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await ready();
  await check(
    'Real WebGL scene, complete inspector and eight independent entities',
    async () => {
      assert.equal((await state()).layout.entities.length, 8);
      assert.ok(
        await page
          .getByRole('button', { name: '开始任务', exact: true })
          .isVisible(),
      );
      const pixels = await page.locator('canvas').evaluate((canvas) => {
        const gl = canvas.getContext('webgl2');
        const p = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(
          0,
          0,
          canvas.width,
          canvas.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          p,
        );
        const colors = new Set();
        for (let i = 0; i < p.length; i += 128)
          colors.add(`${p[i]},${p[i + 1]},${p[i + 2]}`);
        return colors.size;
      });
      assert.ok(pixels > 30, `Canvas colors: ${pixels}`);
      await shot('desktop');
    },
  );
  await check(
    'Centrifuge prepares before counting; second instance stays idle',
    async () => {
      await page.getByRole('button', { name: '开始任务', exact: true }).click();
      await phase('centrifuge-01', 'preparing');
      const s = await state();
      assert.equal(s.devices['centrifuge-01'].remaining, 600);
      assert.equal(s.devices['centrifuge-02'].rpm, 0);
      await phase('centrifuge-01', 'running');
      assert.ok(
        Math.abs((await state()).devices['centrifuge-01'].temperature - 4) <
          0.2,
      );
      await shot('running');
    },
  );
  await check(
    'Stop decelerates, records cancelled, then returns the device to idle',
    async () => {
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await phase('centrifuge-01', 'idle');
      assert.equal((await state()).tasks[0].state, 'cancelled');
      await shot('cancelled');
    },
  );
  await check('Normal completion is distinct from cancellation', async () => {
    await page.getByLabel('预览时间倍率').selectOption('120');
    await page.locator('#target-time').fill('.2');
    await page.getByRole('button', { name: '开始任务', exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__FOUNDATION_PREVIEW__.snapshot().tasks[0]?.state ===
        'completed',
    );
    assert.equal((await state()).devices['centrifuge-01'].phase, 'idle');
    await page.getByLabel('预览时间倍率').selectOption('30');
  });
  await check(
    'Light switch changes the independent device observation',
    async () => {
      await select('light-01');
      await page.getByRole('switch', { name: '照明电源' }).click();
      await page.waitForFunction(
        () => !window.__FOUNDATION_PREVIEW__.snapshot().devices['light-01'].on,
      );
      await shot('light-off');
      await page.getByRole('switch', { name: '照明电源' }).click();
      await page.waitForFunction(
        () => window.__FOUNDATION_PREVIEW__.snapshot().devices['light-01'].on,
      );
    },
  );
  await check(
    'Placement and manually registered location are independent',
    async () => {
      await select('labware-01');
      await page.getByRole('tab', { name: '属性', exact: true }).click();
      await page.locator('#position-X').fill('2.8');
      assert.equal(
        (await state()).layout.entities.find((e) => e.id === 'labware-01')
          .location,
        'bench-02',
      );
      await page.locator('#registered-location').selectOption('bench-01');
      await page
        .getByRole('button', { name: '更新登记位置', exact: true })
        .click();
      const e = (await state()).layout.entities.find(
        (e) => e.id === 'labware-01',
      );
      assert.equal(e.location, 'bench-01');
      assert.equal(e.position[0], 2.8);
      await shot('placement-and-location');
    },
  );
  await check('Saved scene survives an actual browser refresh', async () => {
    await page.getByRole('button', { name: '保存 Lab', exact: true }).click();
    await page.waitForFunction(
      () =>
        !window.__FOUNDATION_PREVIEW__.snapshot().layout.dirty &&
        !window.__FOUNDATION_PREVIEW__.snapshot().meta.saving,
    );
    await page.reload({ waitUntil: 'networkidle' });
    await ready();
    const e = (await state()).layout.entities.find(
      (e) => e.id === 'labware-01',
    );
    assert.equal(e.location, 'bench-01');
    assert.equal(e.position[0], 2.8);
  });
  let addedId;
  await check(
    'Asset to named entity registration is operable end to end',
    async () => {
      await page
        .locator('.world-actions')
        .getByRole('button', { name: '添加对象', exact: true })
        .click();
      await page
        .locator('.asset-card')
        .filter({ hasText: '冷冻离心机' })
        .getByRole('button', { name: '加入 Lab', exact: true })
        .click();
      await page.locator('#new-entity-name').fill('离心机验证');
      await page
        .getByRole('button', { name: '注册并加入 Lab', exact: true })
        .click();
      const s = await state();
      assert.equal(s.layout.entities.length, 9);
      addedId = s.layout.entities.find((e) => e.name === '离心机验证').id;
      await shot('new-entity');
    },
  );
  await check(
    'Actual canvas pointer dragging edits placement without changing location',
    async () => {
      const before = (await state()).layout.entities.find(
        (e) => e.id === addedId,
      );
      const point = await page.evaluate(
        (id) => window.__FOUNDATION_PREVIEW__.project(id),
        addedId,
      );
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 70, point.y - 12, { steps: 12 });
      await page.mouse.up();
      const after = (await state()).layout.entities.find(
        (e) => e.id === addedId,
      );
      assert.notDeepEqual(after.position, before.position);
      assert.equal(after.location, before.location);
    },
  );
  await check(
    'Conflict retains draft and the recovery action can save it',
    async () => {
      const before = (await state()).layout.entities.find(
        (e) => e.id === addedId,
      ).position;
      await page.getByLabel('预览场景').selectOption('conflict');
      await page.getByRole('button', { name: '保存 Lab', exact: true }).click();
      await page.getByText('保存冲突 · 草稿已保留', { exact: true }).waitFor();
      assert.deepEqual(
        (await state()).layout.entities.find((e) => e.id === addedId).position,
        before,
      );
      await shot('save-conflict');
      await page
        .getByRole('button', { name: '保留草稿重试', exact: true })
        .click();
      await page.waitForFunction(
        () => !window.__FOUNDATION_PREVIEW__.snapshot().layout.dirty,
      );
    },
  );
  await check(
    'Agent creates an entity in the same world and can start and stop a task',
    async () => {
      await page
        .getByRole('button', { name: 'Agent 客户端', exact: true })
        .click();
      await page.getByRole('button', { name: '创建照明', exact: true }).click();
      assert.ok(
        (await state()).layout.entities.some(
          (e) => e.name === 'Agent 创建的照明',
        ),
      );
      await page.locator('.agent-dialog select').selectOption('centrifuge-01');
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.waitForFunction(
        () =>
          window.__FOUNDATION_PREVIEW__.snapshot().tasks[0]?.actor === 'Agent',
      );
      await shot('agent-client');
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page
        .locator('.agent-dialog')
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await phase('centrifuge-01', 'idle');
    },
  );
  await check(
    'Disconnected and expired-session scenarios recover without losing layout',
    async () => {
      await page.getByLabel('预览场景').selectOption('offline');
      await page.getByText('实时连接已中断', { exact: true }).waitFor();
      await shot('disconnected');
      await page.getByRole('button', { name: '重新连接', exact: true }).click();
      assert.ok((await state()).meta.connection);
      await page.getByLabel('预览场景').selectOption('expired');
      assert.ok(
        await page
          .getByRole('button', { name: '保存 Lab', exact: true })
          .isDisabled(),
      );
      await page.getByRole('button', { name: '恢复身份', exact: true }).click();
      assert.ok((await state()).meta.authenticated);
    },
  );
  await check(
    'Runtime restart interrupts the task and requires explicit program start',
    async () => {
      await select('centrifuge-01');
      await page.getByRole('button', { name: '开始任务', exact: true }).click();
      await phase('centrifuge-01', 'preparing');
      await page.getByLabel('预览场景').selectOption('restart');
      assert.equal((await state()).tasks[0].state, 'interrupted');
      await shot('runtime-restart');
      await page
        .getByRole('button', { name: '启动设备程序', exact: true })
        .click();
      assert.equal((await state()).devices['centrifuge-01'].phase, 'idle');
      await page.getByLabel('预览场景').selectOption('normal');
    },
  );
  await check(
    'Removing a scene node retains identity and can be undone by placement',
    async () => {
      await select('labware-01');
      await page.getByRole('tab', { name: '属性', exact: true }).click();
      await page.getByRole('button', { name: '移出场景', exact: true }).click();
      await page.getByRole('button', { name: '确认', exact: true }).click();
      assert.equal(
        (await state()).layout.entities.find((e) => e.id === 'labware-01')
          .visible,
        false,
      );
      await page.getByRole('button', { name: '放回场景', exact: true }).click();
      assert.equal(
        (await state()).layout.entities.find((e) => e.id === 'labware-01')
          .visible,
        true,
      );
    },
  );
  await check(
    'Unimplemented robot capabilities are explicitly descriptive',
    async () => {
      await select('robot-01');
      await page.getByText('robot.pick', { exact: true }).waitFor();
      assert.ok(await page.getByText('未实现', { exact: true }).isVisible());
      assert.equal(
        await page
          .getByRole('button', { name: '开始任务', exact: true })
          .count(),
        0,
      );
    },
  );
  await check(
    'GLB import, registration and saved model survive refresh',
    async () => {
      await page.getByRole('link', { name: '资产库', exact: true }).click();
      await page
        .getByLabel('选择 GLB 文件')
        .setInputFiles(
          fileURLToPath(
            new URL('../../../tests/fixtures/lab/cube.glb', import.meta.url),
          ),
        );
      await page
        .locator('.asset-card')
        .filter({ hasText: 'cube' })
        .getByRole('button', { name: '加入 Lab', exact: true })
        .click();
      await page
        .getByRole('button', { name: '注册并加入 Lab', exact: true })
        .click();
      await page.getByRole('button', { name: '保存 Lab', exact: true }).click();
      await page.waitForFunction(
        () => !window.__FOUNDATION_PREVIEW__.snapshot().layout.dirty,
      );
      await page.reload({ waitUntil: 'networkidle' });
      await ready();
      assert.ok((await state()).assets.some((a) => a.name === 'cube'));
      assert.ok(
        (await state()).layout.entities.some((e) => e.kind === 'model'),
      );
    },
  );
  await check('Bad GLB is rejected and catalog remains intact', async () => {
    await page.getByRole('link', { name: '资产库', exact: true }).click();
    const count = (await state()).assets.length;
    await page.getByLabel('选择 GLB 文件').setInputFiles({
      name: 'broken.glb',
      mimeType: 'model/gltf-binary',
      buffer: Buffer.from('not a GLB'),
    });
    await page
      .getByText('请选择有效的 GLB 模型 / Choose a valid GLB model', {
        exact: true,
      })
      .waitFor();
    assert.equal((await state()).assets.length, count);
    await shot('asset-library');
    await page.getByRole('link', { name: 'Lab', exact: true }).click();
  });
  await check('Empty and loading scenes are recoverable', async () => {
    await page.getByLabel('预览场景').selectOption('loading');
    await page.getByText('正在同步世界快照', { exact: true }).waitFor();
    await shot('loading');
    await page.getByLabel('预览场景').selectOption('normal');
    await page.getByLabel('预览场景').selectOption('empty');
    await page.getByText('从第一个对象开始', { exact: true }).waitFor();
    await shot('empty');
    await page
      .getByRole('button', { name: '重置预览示例', exact: true })
      .click();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    assert.equal((await state()).layout.entities.length, 8);
  });
  await check(
    'English, dark mode and narrow-screen controls remain usable',
    async () => {
      await page.locator('a.app-account').click();
      await page
        .locator('.preference-controls')
        .getByRole('button', { name: '暗色', exact: true })
        .click();
      await page
        .getByRole('button', { name: '中文 / English', exact: true })
        .click();
      await page.getByRole('button', { name: 'Open Lab', exact: true }).click();
      await painted();
      await shot('dark-english');
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
        { width: 320, height: 740 },
      ]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(400);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await shot(`viewport-${viewport.width}`);
      }
    },
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      errors,
      warnings: [...new Set(warnings)],
    }),
  );
} catch (error) {
  checks.push({
    name: 'Inspection failure',
    passed: false,
    error: String(error),
    stack: error.stack,
  });
  console.error(error);
  await shot('inspection-failure');
  process.exitCode = 1;
} finally {
  await writeFile(
    `${here}evidence/inspection.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        url,
        environment: 'Headless Chromium, SwiftShader software rendering',
        scope:
          'Isolated browser prototype; no application backend, actual device, performance or production acceptance claim',
        checks,
        errors,
        warnings: [...new Set(warnings)],
      },
      null,
      2,
    ),
  );
  await browser.close();
}
