import { expect, test, type Page } from '@playwright/test';
import { showEntityOperations, showObjectDirectory } from './lab-desktop';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({ locale: 'zh-CN', colorScheme: 'light' });

async function registerObject(page: Page, name: string, kind = 'sensor') {
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption(`${kind}@1.0`);
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

async function cameraSceneFrame(page: Page) {
  return page.locator('.world-viewport canvas').screenshot({
    style:
      '.world-priority-label,.world-priority-labels,.world-canvas-tools,.world-transform-tools { visibility: hidden !important; }',
  });
}

function saveRasterEvidence(
  name: string,
  before: Buffer,
  after: Buffer,
  changedPixels: number,
) {
  if (!process.env.LAB_NODE_EVIDENCE) return;
  try {
    const directory = process.env.LAB_NODE_EVIDENCE;
    writeFileSync(join(directory, `${name}-before.png`), before);
    writeFileSync(join(directory, `${name}-after.png`), after);
    writeFileSync(
      join(directory, `${name}-pixels.json`),
      JSON.stringify({ changedPixels }),
    );
  } catch {
    // Optional raster evidence does not replace the public pixel assertion.
  }
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

async function pickCentredEntity(page: Page, name: string, entityId: string) {
  await page
    .getByRole('checkbox', { name: `多选 ${name}`, exact: true })
    .uncheck();
  await expect(
    page.getByRole('button', { name: `选择 ${name}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () =>
      changedRegionPixels(
        page,
        await cameraSceneFrame(page),
        await cameraSceneFrame(page),
      ),
    )
    .toBe(0);
  const canvas = await page.locator('.world-viewport canvas').boundingBox();
  expect(canvas).not.toBeNull();
  const point = {
    x: canvas!.x + canvas!.width / 2,
    y: canvas!.y + canvas!.height / 2,
  };
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
        point,
      ),
    )
    .toBe('CANVAS');
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('entity'))
    .toBe(entityId);
  await expect(
    page
      .getByRole('complementary', { name: '对象信息' })
      .getByRole('heading', { name, exact: true }),
  ).toBeVisible();
  if (process.env.LAB_NODE_EVIDENCE)
    try {
      writeFileSync(
        join(process.env.LAB_NODE_EVIDENCE, `${entityId}-centre-pick.json`),
        JSON.stringify({
          name,
          entityId,
          selectedEntity: new URL(page.url()).searchParams.get('entity'),
          canvas,
          point,
          pointTarget: 'CANVAS',
        }),
      );
    } catch {
      // Optional identity evidence does not replace the actual canvas pick.
    }
}

test('explicit location frames the selected object while selection and real observations preserve the camera', async ({
  page,
}) => {
  test.setTimeout(90000);
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
  await registerObject(page, 'Camera Sensor A');
  await registerObject(page, 'Camera Sensor B');
  await registerObject(page, 'Asymmetric camera landmark', 'bench');
  const lab = new URL(page.url()).searchParams.get('lab');
  expect(lab).toBeTruthy();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const before = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  const sensorA = before.entities.find(
    (entity: { name: string }) => entity.name === 'Camera Sensor A',
  );
  const sensorB = before.entities.find(
    (entity: { name: string }) => entity.name === 'Camera Sensor B',
  );
  expect(sensorA).toBeTruthy();
  expect(sensorB).toBeTruthy();
  const entityNames = new Map(
    before.entities.map((entity: { id: string; name: string }) => [
      entity.id,
      entity.name,
    ]),
  );
  const placement = await page.request.put(`/api/v1/lab/labs/${lab}/layout`, {
    headers: {
      origin: process.env.E2E_WEB_URL!,
      'x-csrf-token': session.csrf_token,
    },
    data: {
      expected_version: before.lab.layout_version,
      nodes: before.nodes.map(
        (node: {
          id: string;
          entity_id: string;
          representation_id: string | null;
          placement: unknown;
        }) => ({
          id: node.id,
          entity_id: node.entity_id,
          representation_id: node.representation_id,
          placement: {
            position:
              entityNames.get(node.entity_id) === 'Camera Sensor A'
                ? [-2.4, 0.96, 1.8]
                : entityNames.get(node.entity_id) === 'Camera Sensor B'
                  ? [2.4, 0.96, -1.8]
                  : [-2.65, 1.15, 1.47],
            rotation:
              entityNames.get(node.entity_id) === 'Asymmetric camera landmark'
                ? [0, 0.35, 0]
                : [0, 0, 0],
            scale:
              entityNames.get(node.entity_id) === 'Asymmetric camera landmark'
                ? [0.2, 0.2, 0.2]
                : [1, 1, 1],
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
  const beforeFocusA = await cameraSceneFrame(page);
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await expect
    .poll(async () => {
      const after = await cameraSceneFrame(page);
      const changed = await changedRegionPixels(page, beforeFocusA, after);
      saveRasterEvidence('explicit-focus-a', beforeFocusA, after, changed);
      return changed;
    })
    .toBeGreaterThan(30);
  await pickCentredEntity(page, 'Camera Sensor A', sensorA.id);
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
  await pickCentredEntity(page, 'Camera Sensor A', sensorA.id);
  // Remove A's ordinary selection outline before observing the full scene.
  // Remote B's outline remains outside A's view until an explicit locate.
  await page.getByRole('button', { name: '关闭对象信息', exact: true }).click();
  await page
    .getByRole('checkbox', { name: '多选 Camera Sensor A', exact: true })
    .uncheck();
  const selectionCanvas = await page
    .locator('.world-viewport canvas')
    .boundingBox();
  expect(selectionCanvas).not.toBeNull();
  await expect
    .poll(async () =>
      changedRegionPixels(
        page,
        await cameraSceneFrame(page),
        await cameraSceneFrame(page),
      ),
    )
    .toBe(0);
  const beforeSelection = await cameraSceneFrame(page);
  await selectSensor(page, 'Camera Sensor B');
  await page.getByRole('button', { name: '关闭对象信息', exact: true }).click();
  await expect
    .poll(() => page.locator('.world-viewport canvas').boundingBox())
    .toEqual(selectionCanvas);
  const afterSelection = await cameraSceneFrame(page);
  const selectionChangedPixels = await changedRegionPixels(
    page,
    beforeSelection,
    afterSelection,
  );
  saveRasterEvidence(
    'passive-selection',
    beforeSelection,
    afterSelection,
    selectionChangedPixels,
  );
  expect(selectionChangedPixels).toBe(0);
  const beforeFocusB = await cameraSceneFrame(page);
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await expect
    .poll(async () => {
      const after = await cameraSceneFrame(page);
      const changed = await changedRegionPixels(page, beforeFocusB, after);
      saveRasterEvidence('explicit-focus-b', beforeFocusB, after, changed);
      return changed;
    })
    .toBeGreaterThan(30);
  await pickCentredEntity(page, 'Camera Sensor B', sensorB.id);
  const beforePanorama = await cameraSceneFrame(page);
  await page.getByRole('button', { name: '恢复全景', exact: true }).click();
  await expect
    .poll(async () =>
      changedRegionPixels(page, beforePanorama, await cameraSceneFrame(page)),
    )
    .toBeGreaterThan(30);
  const overview = await staticCanvasRegion(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '俯视布局', exact: true }).click();
  await expect
    .poll(async () =>
      changedRegionPixels(page, overview, await staticCanvasRegion(page)),
    )
    .toBeGreaterThan(30);
  await expect(
    page.getByRole('button', { name: '俯视布局', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const beforeDoubleClick = await cameraSceneFrame(page);
  const doubleClickCanvas = await page
    .locator('.world-viewport canvas')
    .boundingBox();
  await page
    .locator('.world-priority-label')
    .getByRole('button', { name: 'Camera Sensor B', exact: true })
    .dblclick();
  await expect
    .poll(() => page.locator('.world-viewport canvas').boundingBox())
    .toEqual(doubleClickCanvas);
  await expect(
    page.getByRole('button', { name: '俯视布局', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(async () => {
      const after = await cameraSceneFrame(page);
      const changed = await changedRegionPixels(page, beforeDoubleClick, after);
      saveRasterEvidence(
        'explicit-label-double-click',
        beforeDoubleClick,
        after,
        changed,
      );
      return changed;
    })
    .toBeGreaterThan(30);
  await pickCentredEntity(page, 'Camera Sensor B', sensorB.id);
  await page.getByRole('button', { name: '关闭对象目录', exact: true }).click();
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 390, height: 844 },
    { width: 320, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 320) {
      await page.getByRole('button', { name: 'English', exact: true }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
    }
    await expect(
      page
        .locator('.world-priority-label')
        .getByRole('button', { name: 'Camera Sensor B', exact: true }),
    ).toBeVisible();
    const readLayout = () =>
      page.locator('.world-viewport canvas').evaluate((canvas) => {
        const area = canvas.getBoundingClientRect();
        const labels = Array.from(
          canvas
            .closest('.world-viewport')!
            .querySelectorAll('.world-priority-label'),
        )
          .filter((label) => getComputedStyle(label).visibility === 'visible')
          .map((label) => label.getBoundingClientRect().toJSON());
        const panels = Array.from(
          canvas
            .closest('.world-page')!
            .querySelectorAll(
              '.world-directory,.world-inspector,.world-history-surface,.world-canvas-tools,.world-transform-tools',
            ),
        )
          .filter((panel) => panel.getClientRects().length)
          .map((panel) => panel.getBoundingClientRect().toJSON());
        const overlaps = (a: DOMRect, b: DOMRect) =>
          a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
        return {
          contained: labels.every(
            (label) =>
              label.x >= area.x &&
              label.right <= area.right &&
              label.y >= area.y &&
              label.bottom <= area.bottom,
          ),
          panelsClear: labels.every((label) =>
            panels.every((panel) => !overlaps(label, panel)),
          ),
          labelsClear: labels.every((label, index) =>
            labels.slice(index + 1).every((other) => !overlaps(label, other)),
          ),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
    await expect.poll(readLayout).toEqual({
      contained: true,
      panelsClear: true,
      labelsClear: true,
      overflow: false,
    });
  }
});
