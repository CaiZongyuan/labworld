import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LabEntity,
  LabRecordsPage,
  LabWorld,
} from '../../packages/sdk/src/index';
import { member } from './lab-foundation-support';

const evidence =
  process.env.LAB_RECORDS_EVIDENCE ??
  '.scratch/33-vnext-lab-records/application';
mkdirSync(evidence, { recursive: true });
test.use({ locale: 'zh-CN' });
test.afterEach(async ({ page }, info) => {
  writeFileSync(
    join(evidence, 'assertions.json'),
    JSON.stringify(
      {
        status: info.status,
        positions: info.errors.flatMap(
          (error) => error.stack?.match(/lab-records\.spec\.ts:\d+:\d+/g) ?? [],
        ),
      },
      null,
      2,
    ),
  );
  if (
    info.status !== info.expectedStatus &&
    new URL(page.url()).pathname === '/lab'
  )
    await page.screenshot({
      path: join(evidence, 'failure.png'),
      animations: 'disabled',
    });
});
async function register(page: Page, definition: string, name: string) {
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  await expect(dialog).toBeHidden();
  return page.getByRole('complementary', { name: '对象信息' });
}
async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}
function immutableBusinessFacts(world: LabWorld) {
  return {
    lab: { id: world.lab.id, layout_version: world.lab.layout_version },
    nodes: world.nodes,
    relationships: world.relationships,
    entities: world.entities.map((entity) => ({
      id: entity.id,
      configuration: entity.configuration,
      definition_id: entity.definition_id,
      definition_version: entity.definition_version,
      binding_id: entity.binding?.id,
      run_id: entity.program_run?.id,
      task_id: entity.task?.id,
      result: entity.task_result,
      archived_at: entity.archived_at,
    })),
  };
}
async function sceneExposure(page: Page, history: Locator) {
  const canvas = page.locator('.world-viewport canvas');
  await expect
    .poll(async () => {
      const [scene, viewport] = await Promise.all([
        canvas.boundingBox(),
        page.locator('.world-viewport').boundingBox(),
      ]);
      return (
        !!scene && !!viewport && Math.abs(scene.height - viewport.height) < 1
      );
    })
    .toBe(true);
  const close = history.getByRole('button', {
    name: /^(关闭运行历史|Close run history)$/,
  });
  await expect(close).toBeInViewport();
  expect(
    await close.evaluate((element) => {
      const rectangle = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rectangle.x + rectangle.width / 2,
        rectangle.y + rectangle.height / 2,
      );
      return hit === element || (!!hit && element.contains(hit));
    }),
  ).toBe(true);
  const scene = await box(canvas),
    panel = await box(history);
  expect(scene.height).toBeGreaterThanOrEqual(180);
  expect(scene.y + scene.height).toBeLessThanOrEqual(panel.y + 1);
  const exposed = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [0.1, 0.5, 0.9].flatMap((x) =>
      [0.1, 0.5, 0.9].map((y) => {
        const hit = document.elementFromPoint(
          bounds.x + bounds.width * x,
          bounds.y + bounds.height * y,
        );
        return hit === element || !!hit?.closest('.world-viewport');
      }),
    );
  });
  expect(exposed.every(Boolean)).toBe(true);
  const png = await canvas.screenshot();
  const palette = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const raster = document.createElement('canvas');
    raster.width = image.width;
    raster.height = image.height;
    const context = raster.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
    const colors = new Set<string>();
    for (let index = 0; index < pixels.length; index += 16)
      colors.add(`${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`);
    return colors.size;
  }, png.toString('base64'));
  expect(palette).toBeGreaterThan(20);
  return { scene, panel, exposed, palette };
}

test('real Lab records retain failed pages, export the current page and open the original result across accepted viewports', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { agent } = await member(page);
  try {
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('名称', { exact: true })
      .fill('Records acceptance Lab');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Records acceptance Lab',
        exact: true,
      }),
    ).toBeVisible();
    const lab = new URL(page.url()).searchParams.get('lab')!;
    const get = async (path: string) => {
      const response = await agent.get(path);
      expect(response.status()).toBe(200);
      return response.json();
    };
    const worldPath = `/api/v1/lab/labs/${lab}/world`;
    const centrifuge = await register(
      page,
      'centrifuge',
      'Recorded centrifuge',
    );
    const entity = ((await get(worldPath)).entities as LabEntity[]).find(
      (item) => item.name === 'Recorded centrifuge',
    )!;
    const path = `/api/v1/lab/labs/${lab}/entities/${entity.id}`;
    await centrifuge
      .getByRole('button', { name: '启动程序', exact: true })
      .click();
    await expect(
      centrifuge.getByRole('button', { name: '开始离心', exact: true }),
    ).toBeEnabled();
    await centrifuge.getByLabel('目标转速 (rpm)').fill('500');
    await centrifuge.getByLabel('目标温度 (degC)').fill('22');
    await centrifuge.getByLabel('任务时长 (s)').fill('6');
    await centrifuge
      .getByRole('button', { name: '开始离心', exact: true })
      .click();
    await expect
      .poll(async () => (await get(path)).task?.status, { timeout: 20000 })
      .toBe('completed');
    const original = (await get(path)).task_result;
    await expect(
      centrifuge.getByRole('button', { name: '开始离心', exact: true }),
    ).toBeEnabled();
    await centrifuge.getByLabel('目标转速 (rpm)').fill('700');
    await centrifuge
      .getByRole('button', { name: '开始离心', exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const current = await get(path);
          return (
            current.task?.status === 'completed' &&
            current.task_result?.id !== original.id
          );
        },
        { timeout: 20000 },
      )
      .toBe(true);
    const latest = (await get(path)).task_result;
    expect((await agent.post(`${path}/program/stop`)).status()).toBe(200);

    const lightName = '=灯, "历史来源"🧪';
    const light = await register(page, 'light', lightName);
    const lightEntity = ((await get(worldPath)).entities as LabEntity[]).find(
      (item) => item.name === lightName,
    )!;
    const lightPath = `/api/v1/lab/labs/${lab}/entities/${lightEntity.id}`;
    await light.getByRole('button', { name: '启动程序', exact: true }).click();
    for (let index = 0; index < 22; index++) {
      const response = await agent.post(`${lightPath}/actions`, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: {
          capability: 'light.set_power',
          parameters: { on: index % 2 === 0 },
        },
      });
      expect(response.status()).toBe(202);
      const command = await response.json();
      await expect
        .poll(
          async () => (await get(`${lightPath}/commands/${command.id}`)).status,
          { timeout: 10000 },
        )
        .toBe('succeeded');
    }
    expect((await agent.post(`${lightPath}/program/stop`)).status()).toBe(200);

    const writes: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() !== 'GET' &&
        new URL(request.url()).pathname.startsWith(`/api/v1/lab/labs/${lab}`)
      )
        writes.push(request.method());
    });
    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    const records = page.getByRole('region', { name: '运行记录', exact: true });
    await expect(records.locator(':scope > ol > li')).toHaveCount(20);
    await expect(
      records.locator(':scope > ol > li').getByText(/命令/).first(),
    ).toBeVisible();
    await expect(
      records.locator(':scope > ol > li').getByText(/事件/).first(),
    ).toBeVisible();
    await records.getByLabel('记录类别').selectOption('run');
    await expect(records.locator(':scope > ol > li')).toHaveCount(2);
    await records.getByLabel('记录类别').selectOption('');
    await records
      .getByLabel('设备', { exact: true })
      .selectOption(lightEntity.id);
    await records.getByLabel('记录类别').selectOption('command');
    await expect(records.locator(':scope > ol > li')).toHaveCount(20);
    const start = new Date(Date.now() - 3600000);
    const end = new Date(Date.now() + 300000);
    const localStart = new Date(
      start.getTime() - start.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 16);
    await records.getByLabel('开始时间').fill(localStart);
    const localEnd = new Date(end.getTime() - end.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    await records.getByLabel('结束时间').fill(localEnd);
    const filteredResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/records?') &&
        new URL(response.url()).searchParams.get('from') ===
          new Date(localStart).toISOString(),
    );
    await records
      .getByRole('button', { name: '查询记录', exact: true })
      .click();
    expect(
      new URL((await filteredResponse).url()).searchParams.has('cursor'),
    ).toBe(false);
    await expect(records.locator(':scope > ol > li')).toHaveCount(20);
    const previousUpper = await records.getByLabel('查询上界').innerText();
    await records
      .getByRole('button', { name: '刷新运行记录', exact: true })
      .click();
    await expect(records.getByLabel('查询上界')).not.toHaveText(previousUpper);
    const upper = await records.getByLabel('查询上界').innerText();
    await page.screenshot({
      path: join(evidence, 'desktop-1440-zh.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.screenshot({
      path: join(evidence, 'desktop-1920-zh.png'),
      animations: 'disabled',
    });

    const attemptedCursors: string[] = [];
    await page.route('**/records?*', (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (cursor) {
        attemptedCursors.push(cursor);
        return route.abort();
      }
      return route.continue();
    });
    await records.getByRole('button', { name: '更早运行记录' }).click();
    await expect(
      records.getByRole('button', { name: '重试记录查询' }),
    ).toBeVisible();
    await expect(records.locator(':scope > ol > li')).toHaveCount(20);
    await page.unroute('**/records?*');
    const olderResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/records?') &&
        new URL(response.url()).searchParams.has('cursor'),
    );
    await records.getByRole('button', { name: '重试记录查询' }).click();
    const older = await olderResponse;
    const loaded: LabRecordsPage = await older.json();
    expect(new URL(older.url()).searchParams.get('cursor')).toBe(
      attemptedCursors[0],
    );
    await expect(records.locator(':scope > ol > li')).toHaveCount(2);
    await expect(records.getByLabel('查询上界')).toHaveText(upper);
    const beforeExport = immutableBusinessFacts(await get(worldPath));
    const download = page.waitForEvent('download');
    await records.getByRole('button', { name: '导出当前页 CSV' }).click();
    const csv = readFileSync((await (await download).path())!, 'utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=灯, ""历史来源""🧪"');
    expect(csv.split('\r\n')).toHaveLength(4);
    for (const item of loaded.items) {
      expect(csv).toContain(`"${item.id}"`);
      expect(csv).toContain(`"${item.recorded_at}"`);
    }
    expect(immutableBusinessFacts(await get(worldPath))).toEqual(beforeExport);
    await expect(records.getByLabel('设备', { exact: true })).toHaveValue(
      lightEntity.id,
    );
    await expect(records.getByLabel('记录类别')).toHaveValue('command');
    await records.getByLabel('设备', { exact: true }).selectOption(entity.id);
    await records.getByLabel('记录类别').selectOption('task');
    await expect(records.locator(':scope > ol > li')).toHaveCount(2);
    await records
      .getByRole('button', {
        name: '打开原对象 Recorded centrifuge',
        exact: true,
      })
      .nth(1)
      .click();
    const originalResult = page.getByRole('region', { name: '原始记录结果' });
    await expect(originalResult).toContainText(original.id);
    await expect(originalResult).not.toContainText(latest.id);
    await expect(page).toHaveURL(new RegExp(`entity=${entity.id}`));
    const inspector = page.getByRole('complementary', { name: '对象信息' });
    await inspector.getByRole('tab', { name: '记录', exact: true }).click();
    await expect(
      inspector.getByRole('tab', { name: '观测', exact: true }),
    ).toBeVisible();

    const geometry = [];
    for (const scenario of [
      { width: 390, locale: 'zh' },
      { width: 320, locale: 'en' },
    ]) {
      if (scenario.locale === 'en') {
        await page
          .getByRole('button', { name: 'English', exact: true })
          .click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: scenario.width, height: 844 });
      const trigger = page.getByRole('button', {
        name: scenario.locale === 'zh' ? '打开运行历史' : 'Open run history',
        exact: true,
      });
      await trigger.click();
      const history = page.locator('.world-history-surface');
      await expect(history).toBeVisible();
      await expect(history.locator('.lab-records > ol > li')).toHaveCount(20);
      const exposure = await sceneExposure(page, history);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: join(evidence, `narrow-${scenario.width}-${scenario.locale}.png`),
        animations: 'disabled',
      });
      await history
        .getByRole('button', {
          name: scenario.locale === 'zh' ? '关闭运行历史' : 'Close run history',
          exact: true,
        })
        .click();
      await expect(trigger).toBeFocused();
      await expect(
        page.getByRole('complementary', {
          name: scenario.locale === 'zh' ? '对象信息' : 'Object info',
        }),
      ).toContainText(entity.id);
      geometry.push({ ...scenario, ...exposure });
    }
    expect(writes).toEqual([]);
    writeFileSync(
      join(evidence, 'observed.json'),
      JSON.stringify(
        {
          originalResult: original.id,
          currentResult: latest.id,
          currentPageItems: loaded.items.length,
          upper,
          geometry,
          worldUnchangedByCsv: true,
          labWritesDuringReadJourney: writes,
        },
        null,
        2,
      ),
    );
  } finally {
    await agent.dispose();
  }
});
