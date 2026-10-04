// Browser evidence for the contextual tour and the permanent controls it teaches.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const previewURL = 'http://127.0.0.1:5194/prototype/lab-onboarding';
const evidence = new URL('./evidence/', import.meta.url);
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const checks = [];
const pageErrors = [];
async function open(width, locale = 'zh', theme = 'light') {
  const page = await browser.newPage({
    viewport: { width, height: width <= 450 ? 844 : 1000 },
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(
    ({ locale, theme }) => {
      localStorage.setItem('labos-threejs.locale', locale);
      localStorage.setItem('labos-threejs.theme', theme);
    },
    { locale, theme },
  );
  await page.goto(previewURL);
  await page.locator('canvas').waitFor();
  return page;
}
async function state(page) {
  return page.evaluate(() => {
    const world = JSON.parse(
      localStorage.getItem('PROTOTYPE-lab-onboarding-v2') ?? 'null',
    );
    return {
      world,
      tour: JSON.parse(
        localStorage.getItem('PROTOTYPE-lab-onboarding-v2-tour') ?? 'null',
      ),
      lab: world?.labs.find((lab) => lab.id === world.activeId),
    };
  });
}
async function geometry(page, target) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  return page.evaluate((target) => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    };
    const popover = document.querySelector('.driver-popover');
    const anchor = document.querySelector(`[data-tour="${target}"]`);
    return {
      width: innerWidth,
      height: innerHeight,
      anchor: rect(anchor),
      popover: rect(popover),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  }, target);
}
async function step(page, target, label) {
  await expect(page.locator('.driver-popover')).toHaveAttribute(
    'data-tour-target',
    target,
  );
  const boxes = await geometry(page, target);
  assert.equal(boxes.overflow, false);
  assert.ok(
    boxes.popover.x >= -1 && boxes.popover.y >= -1,
    `${target}: popover begins outside viewport`,
  );
  assert.ok(
    boxes.popover.right <= boxes.width + 1 &&
      boxes.popover.bottom <= boxes.height + 1,
    `${target}: popover ends outside viewport`,
  );
  const overlap =
    Math.max(
      0,
      Math.min(boxes.popover.right, boxes.anchor.right) -
        Math.max(boxes.popover.x, boxes.anchor.x),
    ) *
    Math.max(
      0,
      Math.min(boxes.popover.bottom, boxes.anchor.bottom) -
        Math.max(boxes.popover.y, boxes.anchor.y),
    );
  assert.equal(
    overlap,
    0,
    `${target}: coachmark obscures the highlighted control`,
  );
  if (label)
    await page.screenshot({ path: new URL(`${label}.png`, evidence).pathname });
  return boxes;
}
async function pixels(page) {
  return page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2');
    const bytes = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(
      0,
      0,
      canvas.width,
      canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    );
    const colors = new Set();
    for (let i = 0; i < bytes.length; i += 64)
      colors.add(`${bytes[i] >> 4},${bytes[i + 1] >> 4},${bytes[i + 2] >> 4}`);
    return { width: canvas.width, height: canvas.height, colors: colors.size };
  });
}
async function journey(width, locale = 'zh', theme = 'light') {
  const page = await open(width, locale, theme);
  const key = `${width}-${locale}-${theme}`;
  const anchors = [];
  anchors.push(await step(page, 'create-lab', `first-${key}`));
  await expect(page.locator('.driver-popover-next-btn')).toBeHidden();
  await page.locator('[data-tour="create-lab"]').click();
  anchors.push(await step(page, 'create-form', `create-${key}`));
  await page
    .locator('#lab-name')
    .fill(locale === 'zh' ? '视觉引导实验室' : 'Guided laboratory');
  await page.locator('[data-tour="create-form"] button[type="submit"]').click();
  anchors.push(await step(page, 'register'));
  assert.equal((await state(page)).lab.entities.length, 3);
  await page.locator('[data-tour="register"]').click();
  anchors.push(await step(page, 'register-form', `register-${key}`));
  await page
    .locator('[data-tour="register-form"] button[type="submit"]')
    .click();
  anchors.push(await step(page, 'light-row'));
  await page.locator('[data-tour="light-row"]').click();
  anchors.push(await step(page, 'edit-mode'));
  await page.locator('[data-tour="edit-mode"]').click();
  anchors.push(await step(page, 'placement', `placement-${key}`));
  await expect(page.locator('.driver-popover-next-btn')).toBeDisabled();
  await page.locator('#placement-X').fill('-3');
  await expect(page.locator('.driver-popover-next-btn')).toBeEnabled();
  await page.locator('.driver-popover-next-btn').click();
  anchors.push(await step(page, 'save'));
  await page.locator('[data-tour="save"]').click();
  anchors.push(await step(page, 'runtime-mode'));
  await page.locator('[data-tour="runtime-mode"]').click();
  anchors.push(await step(page, 'program'));
  await page.locator('[data-tour="program"]').click();
  anchors.push(await step(page, 'light-controls', `controls-${key}`));
  await page.getByRole('button', { name: /应用亮度|Apply brightness/ }).click();
  anchors.push(await step(page, 'light-reading', `reading-${key}`));
  const pixel = await pixels(page);
  assert.ok(pixel.colors > 20, '3D canvas must contain actual scene pixels');
  const completed = await state(page);
  assert.equal(completed.lab.entities.length, 4);
  assert.equal(completed.lab.dirty, false);
  assert.equal(completed.lab.devices[completed.tour.entityId].brightness, 65);
  await page.locator('.driver-popover-next-btn').click();
  anchors.push(await step(page, 'assets'));
  await page.locator('[data-tour="assets"]').click();
  anchors.push(await step(page, 'help', `finish-${key}`));
  await page.locator('.driver-popover-next-btn').click();
  await expect(page.locator('.driver-popover')).toHaveCount(0);
  assert.equal((await state(page)).tour.status, 'completed');
  await page.locator('canvas').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('canvas').waitFor();
  await expect(page.locator('.driver-popover')).toHaveCount(0);
  checks.push({
    name: `${key}: fourteen real-control steps, unobscured anchors, nonblank canvas and no automatic replay after completion`,
    anchors,
    pixels: pixel,
  });
  return page;
}
try {
  const desktop = await journey(1600);
  const beforeReview = await state(desktop);
  await desktop.locator('[data-tour="help"]').click();
  const reviewTargets = [
    'create-lab',
    'register',
    'directory',
    'edit-mode',
    'placement',
    'save',
    'runtime-mode',
    'program-section',
    'light-controls',
    'light-reading',
    'history',
    'assets',
    'help',
  ];
  for (const target of reviewTargets) {
    await step(desktop, target);
    await desktop.locator('.driver-popover-next-btn').click();
  }
  await expect(desktop.locator('.driver-popover')).toHaveCount(0);
  const afterReview = await state(desktop);
  assert.deepEqual(afterReview.lab.entities, beforeReview.lab.entities);
  assert.equal(afterReview.lab.revision, beforeReview.lab.revision);
  checks.push({
    name: 'Question-mark review revisits thirteen permanent control locations without creating objects or saving a new revision',
  });
  await desktop.close();

  const paused = await open(1440);
  await paused.locator('[data-tour="create-lab"]').click();
  await paused
    .locator('[data-tour="create-form"] button[type="submit"]')
    .click();
  await step(paused, 'register');
  await paused.getByRole('button', { name: '跳过引导' }).click();
  await expect(paused.locator('.driver-popover')).toHaveCount(0);
  await paused.reload();
  await expect(paused.locator('.driver-popover')).toHaveCount(0);
  await paused.locator('[data-tour="help"]').click();
  await step(paused, 'register');
  assert.equal((await state(paused)).lab.entities.length, 3);
  checks.push({
    name: 'Skip and refresh preserve the lab; the help button resumes at the registration control',
  });
  await paused.getByRole('button', { name: '跳过引导' }).click();
  await paused
    .getByRole('combobox', { name: '预览场景' })
    .selectOption('create-failure');
  await step(paused, 'create-lab');
  await paused.locator('[data-tour="create-lab"]').click();
  await paused.locator('#lab-name').fill('失败后保留名称');
  await paused
    .locator('[data-tour="create-form"] button[type="submit"]')
    .click();
  await expect(paused.locator('.form-error')).toBeVisible();
  await step(paused, 'create-form');
  await expect(paused.locator('#lab-name')).toHaveValue('失败后保留名称');
  await paused
    .locator('[data-tour="create-form"] button[type="submit"]')
    .click();
  await step(paused, 'register');
  assert.equal((await state(paused)).world.labs.length, 1);
  checks.push({
    name: 'Creation failure keeps the form highlighted and preserves input; retry creates exactly one lab',
  });
  await paused.getByRole('button', { name: '跳过引导' }).click();
  await paused
    .getByRole('combobox', { name: '预览场景' })
    .selectOption('save-failure');
  await step(paused, 'save');
  await paused.locator('[data-tour="save"]').click();
  await expect(paused.locator('.form-error')).toBeVisible();
  await step(paused, 'save');
  assert.equal((await state(paused)).lab.dirty, true);
  await paused.locator('[data-tour="save"]').click();
  await step(paused, 'runtime-mode');
  checks.push({
    name: 'Save failure stays at the same control, preserves placement and advances only after a successful retry',
  });
  await paused.close();

  const mobile390 = await journey(390);
  await mobile390.close();
  const mobile320 = await journey(320, 'en', 'dark');
  await mobile320.close();
  assert.deepEqual(pageErrors, []);
  await writeFile(
    new URL('inspection.json', evidence),
    JSON.stringify(
      {
        browser: browser.version(),
        url: previewURL,
        checks,
        pageErrors,
        simulated: [
          'World API',
          'Identity',
          'Device runtime',
          'Failure injection',
        ],
        real: [
          'Driver.js spotlight positioning',
          'Shared shell and shadcn controls',
          'Normal forms and workflow',
          'Three.js geometry, camera and observed lighting',
          'Isolated local persistence',
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, pageErrors }, null, 2));
} finally {
  await browser.close();
}
