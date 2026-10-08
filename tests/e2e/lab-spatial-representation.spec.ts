import { expect, test, type Page } from '@playwright/test';
import { showEntityOperations, showObjectDirectory } from './lab-desktop';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({ locale: 'zh-CN', colorScheme: 'light' });

async function registerSensor(page: Page, name: string) {
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption('sensor@1.0');
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function selectSensor(page: Page, name: string) {
  await showObjectDirectory(page);
  await page.getByRole('button', { name: `选择 ${name}`, exact: true }).click();
  await showEntityOperations(page);
}

async function labelHorizontalOffset(page: Page, name: string) {
  const canvas = await page.locator('.world-viewport canvas').boundingBox();
  const label = await page
    .getByRole('img', { name: new RegExp(`^${name}:`) })
    .boundingBox();
  expect(canvas).not.toBeNull();
  expect(label).not.toBeNull();
  const offset =
    (label!.x + label!.width / 2 - canvas!.x - canvas!.width / 2) /
    canvas!.height;
  if (process.env.LAB_NODE_EVIDENCE)
    try {
      writeFileSync(
        join(process.env.LAB_NODE_EVIDENCE, 'camera-label-metrics.json'),
        JSON.stringify({ name, canvas, label, offset }),
      );
    } catch {
      // Optional geometry evidence does not replace the camera assertion.
    }
  return offset;
}

async function staticCanvasRegion(page: Page) {
  const canvas = await page.locator('.world-viewport canvas').boundingBox();
  expect(canvas).not.toBeNull();
  // The selected sensor's lower body and grid are below its changing reading.
  return page.screenshot({
    clip: {
      x: canvas!.x,
      y: canvas!.y + canvas!.height * 0.55,
      width: canvas!.width,
      height: canvas!.height * 0.45,
    },
  });
}

async function changedRegionPixels(page: Page, before: Buffer, after: Buffer) {
  return page.evaluate(
    async (encoded) => {
      const frames = await Promise.all(
        encoded.map(async (value) => {
          const image = new Image();
          image.src = `data:image/png;base64,${value}`;
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
      for (let i = 0; i < frames[0].length; i += 4)
        if (
          Math.abs(frames[0][i] - frames[1][i]) +
            Math.abs(frames[0][i + 1] - frames[1][i + 1]) +
            Math.abs(frames[0][i + 2] - frames[1][i + 2]) >
          30
        )
          changed++;
      return changed;
    },
    [before.toString('base64'), after.toString('base64')],
  );
}

test('explicit location frames the selected object while selection and real observations preserve the camera', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`spatial-camera-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('spatial-camera-fixture-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('名称', { exact: true })
    .fill('Camera location fixture');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog).toBeHidden();
  await registerSensor(page, 'Camera Sensor A');
  await registerSensor(page, 'Camera Sensor B');
  const lab = new URL(page.url()).searchParams.get('lab');
  expect(lab).toBeTruthy();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const before = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  const placement = await page.request.put(`/api/v1/lab/labs/${lab}/layout`, {
    headers: {
      origin: process.env.E2E_WEB_URL!,
      'x-csrf-token': session.csrf_token,
    },
    data: {
      expected_version: before.lab.layout_version,
      nodes: before.nodes.map(
        (
          node: {
            id: string;
            entity_id: string;
            representation_id: string | null;
            placement: unknown;
          },
          index: number,
        ) => ({
          id: node.id,
          entity_id: node.entity_id,
          representation_id: node.representation_id,
          placement: {
            position: index === 0 ? [-2.4, 0, 1.8] : [2.4, 0, -1.8],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        }),
      ),
      relationships: [],
    },
  });
  expect(placement.status()).toBe(200);
  await page.reload();
  await expect(page.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await selectSensor(page, 'Camera Sensor A');
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await expect
    .poll(async () =>
      Math.abs(await labelHorizontalOffset(page, 'Camera Sensor A')),
    )
    .toBeLessThan(0.05);
  await expect
    .poll(async () =>
      changedRegionPixels(
        page,
        await staticCanvasRegion(page),
        await staticCanvasRegion(page),
      ),
    )
    .toBe(0);
  const staticBefore = await staticCanvasRegion(page);
  await page
    .getByRole('complementary', { name: '对象信息' })
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await expect(page.getByLabel('关键观测有效性')).toHaveText(
    '当前关键观测有效',
  );
  expect(
    await changedRegionPixels(
      page,
      staticBefore,
      await staticCanvasRegion(page),
    ),
  ).toBe(0);
  await page.locator('.world-viewport canvas').hover();
  await page.mouse.wheel(0, -200);
  await expect
    .poll(async () =>
      changedRegionPixels(page, staticBefore, await staticCanvasRegion(page)),
    )
    .toBeGreaterThan(30);
  await expect
    .poll(async () =>
      Math.abs(await labelHorizontalOffset(page, 'Camera Sensor A')),
    )
    .toBeLessThan(0.05);
  await selectSensor(page, 'Camera Sensor B');
  expect(
    Math.abs(await labelHorizontalOffset(page, 'Camera Sensor B')),
  ).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await expect
    .poll(async () =>
      Math.abs(await labelHorizontalOffset(page, 'Camera Sensor B')),
    )
    .toBeLessThan(0.05);
});
