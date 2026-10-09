import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labRepresentationProfiles } from '../../packages/contracts/src/lab-representations';
import { showEntityOperations, showObjectDirectory } from './lab-desktop';

test.use({ locale: 'zh-CN', colorScheme: 'light' });
const sceneStyle =
  '.world-priority-label,.world-priority-labels,.world-canvas-tools,.world-transform-tools,.lab-perf { visibility: hidden !important; }';
async function frame(
  page: Page,
  area?: { x: number; y: number; width: number; height: number },
) {
  const canvas =
    area ?? (await page.locator('.world-viewport canvas').boundingBox());
  expect(canvas).not.toBeNull();
  return page.screenshot({ clip: canvas!, style: sceneStyle });
}
async function changedPixels(page: Page, before: Buffer, after: Buffer) {
  if (before.equals(after)) {
    retain('native-last-pixel-measurement.json', { changed: 0, bounds: null });
    return 0;
  }
  const measured = await page.evaluate(
    async (encoded) => {
      let width = 0;
      const pixels = await Promise.all(
        encoded.map(async (value) => {
          const image = new Image();
          image.src = `data:image/png;base64,${value}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height).data;
        }),
      );
      let changed = 0;
      let minX = Infinity,
        minY = Infinity,
        maxX = -1,
        maxY = -1;
      for (let i = 0; i < pixels[0].length; i += 4)
        if (
          Math.abs(pixels[0][i] - pixels[1][i]) +
            Math.abs(pixels[0][i + 1] - pixels[1][i + 1]) +
            Math.abs(pixels[0][i + 2] - pixels[1][i + 2]) >
          30
        ) {
          changed++;
          const x = (i / 4) % width,
            y = Math.floor(i / 4 / width);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      return { changed, bounds: changed ? { minX, minY, maxX, maxY } : null };
    },
    [before.toString('base64'), after.toString('base64')],
  );
  retain('native-last-pixel-measurement.json', measured);
  return measured.changed;
}
async function select(page: Page, name: string) {
  await showObjectDirectory(page);
  await page.getByRole('button', { name: `选择 ${name}`, exact: true }).click();
  await showEntityOperations(page);
}
function retain(name: string, value: unknown) {
  if (process.env.LAB_NODE_EVIDENCE)
    writeFileSync(
      join(process.env.LAB_NODE_EVIDENCE, name),
      JSON.stringify(value, null, 2),
    );
}

test('registered native representations form the accepted space and retain last light appearance while releasing their resources', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`native-space-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('native-space-fixture-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('名称', { exact: true })
    .fill('Registered representation fixture');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog).toBeHidden();
  const lab = new URL(page.url()).searchParams.get('lab')!;
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = {
    origin: process.env.E2E_WEB_URL!,
    'x-csrf-token': session.csrf_token,
  };
  await expect(page.locator('.world-viewport canvas')).toBeVisible();
  await page.getByRole('button', { name: '性能', exact: true }).click();
  const geometries = page
    .locator('.lab-perf-stats > div')
    .filter({ has: page.getByText('Geometries', { exact: true }) })
    .locator('dd');
  await expect
    .poll(async () => Number(await geometries.innerText()))
    .toBeGreaterThan(0);
  const coldGeometries = Number(await geometries.innerText());
  const textures = page
    .locator('.lab-perf-stats > div')
    .filter({ has: page.getByText('Textures', { exact: true }) })
    .locator('dd');
  const triangles = page
    .locator('.lab-perf-stats > div')
    .filter({ has: page.getByText('三角形', { exact: true }) })
    .locator('dd');
  const coldTextures = Number(await textures.innerText());
  const coldTriangles = Number(
    (await triangles.innerText()).replaceAll(',', ''),
  );
  let emptyGeometries = coldGeometries;
  let warmupNode:
    | { id: string; entity_id: string; representation_id: string | null }
    | undefined;
  const worktop = labRepresentationProfiles.profiles.bench.worktopHeight;
  const objects = [
    { name: '实验台 A', kind: 'bench', position: [-0.7, 0, -0.7] },
    { name: '实验台 B', kind: 'bench', position: [0.65, 0, 1.65] },
    { name: '离心机 01', kind: 'centrifuge', position: [-1.35, worktop, -0.7] },
    { name: '离心机 02', kind: 'centrifuge', position: [-0.15, worktop, -0.7] },
    { name: '温度传感器 01', kind: 'sensor', position: [0.35, worktop, -0.48] },
    { name: '照明 01', kind: 'light', position: [-2.5, 0, -0.8] },
    { name: '机械臂 01', kind: 'robot', position: [0.05, worktop, 1.65] },
    { name: '烧杯 01', kind: 'labware', position: [1.65, worktop, 1.65] },
  ];
  const ids = new Map<string, string>();
  for (const object of objects) {
    const response = await page.request.post(
      `/api/v1/lab/labs/${lab}/entities`,
      {
        headers,
        data: {
          name: object.name,
          definition_id: object.kind,
          definition_version: '1.0',
          reality: 'simulated',
          representation_id: null,
          configuration:
            object.kind === 'light' ? { on: true, brightness: 65 } : {},
        },
      },
    );
    expect(response.status()).toBe(201);
    ids.set((await response.json()).id, object.name);
    if (object === objects[0]) {
      await select(page, object.name);
      await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
      await expect
        .poll(async () => Number(await textures.innerText()))
        .toBeGreaterThan(coldTextures);
      const renderedBench = await frame(page);
      const colours = await page.evaluate(async (encoded) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, image.width, image.height).data;
        const colours = new Set<string>();
        for (let i = 0; i < data.length; i += 16)
          colours.add(
            `${data[i] >> 4}:${data[i + 1] >> 4}:${data[i + 2] >> 4}`,
          );
        return colours.size;
      }, renderedBench.toString('base64'));
      expect(colours).toBeGreaterThan(30);
      if (process.env.LAB_NODE_EVIDENCE)
        writeFileSync(
          join(process.env.LAB_NODE_EVIDENCE, 'native-warmup-bench.png'),
          renderedBench,
        );
      const warmWorld = await (
        await page.request.get(`/api/v1/lab/labs/${lab}/world`)
      ).json();
      warmupNode = warmWorld.nodes[0];
      const removed = await page.request.put(`/api/v1/lab/labs/${lab}/layout`, {
        headers,
        data: {
          expected_version: warmWorld.lab.layout_version,
          nodes: [],
          relationships: [],
        },
      });
      expect(removed.status()).toBe(200);
      await expect(page.locator('.lab-heading')).toContainText(
        `v${warmWorld.lab.layout_version + 1}`,
      );
      await expect
        .poll(async () =>
          Number((await triangles.innerText()).replaceAll(',', '')),
        )
        .toBeLessThanOrEqual(coldTriangles);
      emptyGeometries = Number(await geometries.innerText());
      const warmEmpty = await (
        await page.request.get(`/api/v1/lab/labs/${lab}/world`)
      ).json();
      expect(warmEmpty.nodes).toHaveLength(0);
      expect(warmEmpty.entities).toHaveLength(1);
      retain('native-warmed-empty.json', {
        coldGeometries,
        coldTextures,
        coldTriangles,
        emptyGeometries,
        emptyTextures: Number(await textures.innerText()),
        renderedColours: colours,
        node: warmupNode,
        entities: warmEmpty.entities.map((entity: { id: string }) => entity.id),
      });
    }
  }
  const before = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  expect(before.entities).toHaveLength(8);
  const saved = await page.request.put(`/api/v1/lab/labs/${lab}/layout`, {
    headers,
    data: {
      expected_version: before.lab.layout_version,
      nodes: [...before.nodes, warmupNode!].map(
        (node: {
          id: string;
          entity_id: string;
          representation_id: string | null;
        }) => ({
          id: node.id,
          entity_id: node.entity_id,
          representation_id: node.representation_id,
          placement: {
            position: objects.find(
              (object) => object.name === ids.get(node.entity_id),
            )!.position,
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        }),
      ),
      relationships: [],
    },
  });
  expect(saved.status()).toBe(200);
  await expect(page.locator('.lab-heading')).toContainText(
    `v${before.lab.layout_version + 1}`,
  );
  await expect(page.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect
    .poll(async () => Number(await geometries.innerText()))
    .toBeGreaterThan(emptyGeometries);
  for (const name of ['温度传感器 01', '离心机 01', '离心机 02']) {
    await select(page, name);
    await page
      .getByRole('complementary', { name: '对象信息' })
      .getByRole('button', { name: '启动程序', exact: true })
      .click();
    await expect(page.getByLabel('关键观测有效性')).toHaveText(
      '当前关键观测有效',
    );
  }
  await select(page, '照明 01');
  retain(
    'native-pre-light-world.json',
    await (await page.request.get(`/api/v1/lab/labs/${lab}/world`)).json(),
  );
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  const staticInspector = await page.locator('.world-inspector').boundingBox();
  let staticPacket:
    | {
        before: Buffer;
        after: Buffer;
        changed: number;
        areaBefore: unknown;
        areaAfter: unknown;
        elapsed: {
          firstScreenshotMs: number;
          secondScreenshotMs: number;
          measuredMs: number;
        };
      }
    | undefined;
  try {
    await expect
      .poll(async () => {
        const started = Date.now();
        const areaBefore = await page
          .locator('.world-viewport canvas')
          .boundingBox();
        expect(areaBefore).not.toBeNull();
        const before = await frame(page, areaBefore!);
        const firstScreenshotMs = Date.now() - started;
        const after = await frame(page, areaBefore!);
        const secondScreenshotMs = Date.now() - started;
        const changed = await changedPixels(page, before, after);
        const areaAfter = await page
          .locator('.world-viewport canvas')
          .boundingBox();
        staticPacket = {
          before,
          after,
          changed,
          areaBefore,
          areaAfter,
          elapsed: {
            firstScreenshotMs,
            secondScreenshotMs,
            measuredMs: Date.now() - started,
          },
        };
        expect(areaAfter).toEqual(areaBefore);
        return changed;
      })
      .toBe(0);
  } finally {
    if (process.env.LAB_NODE_EVIDENCE && staticPacket) {
      writeFileSync(
        join(process.env.LAB_NODE_EVIDENCE, 'native-static-before.png'),
        staticPacket.before,
      );
      writeFileSync(
        join(process.env.LAB_NODE_EVIDENCE, 'native-static-after.png'),
        staticPacket.after,
      );
      retain('native-static-pixels.json', {
        changedPixels: staticPacket.changed,
        areaBefore: staticPacket.areaBefore,
        areaAfter: staticPacket.areaAfter,
        inspector: staticInspector,
        elapsed: staticPacket.elapsed,
      });
    }
  }
  const unreportedLight = await frame(page);
  await page
    .getByRole('complementary', { name: '对象信息' })
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await page.getByLabel('目标亮度 (%)').fill('65');
  await page
    .getByRole('complementary', { name: '对象信息' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByLabel('关键观测有效性')).toHaveText(
    '当前关键观测有效',
  );
  await expect(page.getByRole('img', { name: /^照明 01:/ })).toContainText(
    '65',
  );
  await expect
    .poll(async () => changedPixels(page, unreportedLight, await frame(page)))
    .toBeGreaterThan(30);
  await select(page, '离心机 01');
  await page.getByRole('button', { name: '恢复全景', exact: true }).click();
  await expect
    .poll(async () => changedPixels(page, await frame(page), await frame(page)))
    .toBe(0);
  const canvas = await page.locator('.world-viewport canvas').boundingBox();
  expect(canvas).not.toBeNull();
  await expect(page.getByRole('img', { name: /^离心机 01:/ })).toContainText(
    '空闲',
  );
  await expect(
    page.getByRole('img', { name: /^温度传感器 01:/ }),
  ).toContainText('degC');
  await expect(page.locator('.world-render-error')).toHaveCount(0);
  const registeredGeometries = Number(await geometries.innerText());
  await page.getByRole('button', { name: '性能', exact: true }).click();
  await page.screenshot({
    path: process.env.LAB_NODE_EVIDENCE
      ? join(process.env.LAB_NODE_EVIDENCE, 'native-space-1600-zh-light.png')
      : info.outputPath('native-space-1600-zh-light.png'),
  });
  await page.locator('.world-viewport canvas').screenshot({
    path: process.env.LAB_NODE_EVIDENCE
      ? join(process.env.LAB_NODE_EVIDENCE, 'native-space-1600-canvas.png')
      : info.outputPath('native-space-1600-canvas.png'),
  });
  retain('native-space-facts.json', {
    viewport: { width: 1600, height: 1000 },
    canvas,
    objects,
    ids: Object.fromEntries(ids),
    metadataFormat: labRepresentationProfiles.format,
    emptyGeometries,
    registeredGeometries,
    source:
      'actual registered World and real server programs; representation dimensions, no room identity',
  });
  await page.getByRole('button', { name: '性能', exact: true }).click();
  await select(page, '照明 01');
  await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
  await expect
    .poll(async () => changedPixels(page, await frame(page), await frame(page)))
    .toBe(0);
  const reportedLight = await frame(page);
  await page
    .getByRole('complementary', { name: '对象信息' })
    .getByRole('button', { name: '停止程序', exact: true })
    .click();
  await expect(page.getByRole('img', { name: /^照明 01:/ })).toContainText(
    '最后报告值',
  );
  const afterStop = await frame(page);
  const stoppedPixels = await changedPixels(page, reportedLight, afterStop);
  expect(stoppedPixels).toBe(0);
  try {
    await context.setOffline(true);
    await expect(page.getByText('连接中断', { exact: true })).toBeVisible();
    const offlinePixels = await changedPixels(
      page,
      afterStop,
      await frame(page),
    );
    expect(offlinePixels).toBe(0);
    retain('light-last-appearance.json', {
      stoppedPixels,
      offlinePixels,
      reading: await page.getByRole('img', { name: /^照明 01:/ }).innerText(),
    });
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  const world = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  const cleared = await page.request.put(`/api/v1/lab/labs/${lab}/layout`, {
    headers,
    data: {
      expected_version: world.lab.layout_version,
      nodes: [],
      relationships: [],
    },
  });
  expect(cleared.status()).toBe(200);
  await expect(page.locator('.lab-heading')).toContainText(
    `v${world.lab.layout_version + 1}`,
  );
  retain('native-final-empty-before-assert.json', {
    coldGeometries,
    emptyGeometries,
    geometries: Number(await geometries.innerText()),
    textures: Number(await textures.innerText()),
    world: await (
      await page.request.get(`/api/v1/lab/labs/${lab}/world`)
    ).json(),
  });
  await expect
    .poll(async () => Number(await geometries.innerText()))
    .toBeLessThanOrEqual(emptyGeometries);
  const retained = await (
    await page.request.get(`/api/v1/lab/labs/${lab}/world`)
  ).json();
  expect(retained.entities).toHaveLength(8);
  expect(retained.nodes).toHaveLength(0);
  retain('native-release.json', {
    emptyGeometries,
    afterReleaseGeometries: Number(await geometries.innerText()),
    retainedEntities: retained.entities.map(
      (entity: { id: string }) => entity.id,
    ),
  });
  expect(errors).toEqual([]);
});
