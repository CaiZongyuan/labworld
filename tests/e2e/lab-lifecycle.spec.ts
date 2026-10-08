import {
  expect,
  test,
  request as playwrightRequest,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { showEntityDetails, showEntityOperations } from './lab-desktop';

const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });
async function pixels(page: Page, filename: string) {
  const png = await page
    .locator('canvas')
    .screenshot({ path: `test-results/lab-foundation/${filename}` });
  const colors = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let i = 0; i < data.length; i += 16)
      colors.add(`${data[i] >> 4}:${data[i + 1] >> 4}:${data[i + 2] >> 4}`);
    return colors.size;
  }, png.toString('base64'));
  expect(colors).toBeGreaterThan(20);
}
test('real Entity lifecycle retains Tasks and sources across GLB replacement, node recovery and archive', async ({
  page,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`lifecycle-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('lifecycle-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('link', { name: '资产库', exact: true }).click();
  for (const name of ['cube-draco', 'cube-basis']) {
    await page
      .getByLabel('GLB 文件')
      .setInputFiles(`tests/fixtures/lab/${name}.glb`);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '发布资产' })
      .click();
    await expect(page.getByText(`${name}.glb`, { exact: true })).toBeVisible();
  }
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = {
    origin: process.env.E2E_WEB_URL!,
    'x-csrf-token': session.csrf_token,
  };
  const credential = await (
    await page.request.post('/api/v1/api-keys', {
      headers,
      data: {
        name: 'Lifecycle Agent',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
    })
  ).json();
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${credential.secret}` },
  });
  const get = async (path: string) => {
    const response = await agent.get(path);
    expect(response.status()).toBe(200);
    return response.json();
  };
  try {
    const assets = (await get('/api/v1/lab/assets')).data;
    const draco = assets.find(
      (asset: { name: string }) => asset.name === 'cube-draco',
    );
    const basis = assets.find(
      (asset: { name: string }) => asset.name === 'cube-basis',
    );
    await page.getByRole('link', { name: 'Lab', exact: true }).click();
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('名称', { exact: true })
      .fill('Lifecycle lab');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '创建', exact: true })
      .click();
    await page.getByRole('button', { name: '登记对象', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('定义版本')
      .selectOption('centrifuge@1.0');
    await page
      .getByRole('dialog')
      .getByLabel('名称', { exact: true })
      .fill('Lifecycle centrifuge');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '登记', exact: true })
      .click();
    const inspector = page.getByRole('complementary', { name: '对象信息' });
    await expect(
      inspector.getByRole('heading', {
        name: 'Lifecycle centrifuge',
        exact: true,
      }),
    ).toBeVisible();
    await showEntityDetails(page);
    const entity = await inspector
      .locator('dt')
      .filter({ hasText: /^Entity$/ })
      .locator('+ dd')
      .innerText();
    const lab = await inspector
      .locator('dt')
      .filter({ hasText: /^Lab$/ })
      .locator('+ dd')
      .innerText();
    const path = `/api/v1/lab/labs/${lab}/entities/${entity}`;
    await showEntityOperations(page);
    await inspector
      .getByRole('button', { name: '启动程序', exact: true })
      .click();
    await inspector.getByLabel('目标转速 (rpm)').fill('500');
    await inspector.getByLabel('目标温度 (degC)').fill('22');
    await inspector.getByLabel('任务时长 (s)').fill('6');
    await inspector
      .getByRole('button', { name: '开始离心', exact: true })
      .click();
    await expect.poll(async () => (await get(path)).task?.id).toBeTruthy();
    const before = await get(path);
    const archived = await agent.post(`${path}/archive`);
    expect(archived.status()).toBe(409);
    expect((await archived.json()).error.code).toBe('lab.entity_in_use');
    expect(
      (
        await agent.put(`${path}/definition`, {
          data: {
            definition_id: 'sensor',
            definition_version: '1.0',
            configuration: {},
          },
        })
      ).status(),
    ).toBe(409);
    await page.getByRole('button', { name: '性能', exact: true }).click();
    const geometries = page
      .locator('.lab-perf-stats > div')
      .filter({ has: page.getByText('Geometries', { exact: true }) })
      .locator('dd');
    const textures = page
      .locator('.lab-perf-stats > div')
      .filter({ has: page.getByText('Textures', { exact: true }) })
      .locator('dd');
    await expect
      .poll(async () => Number(await geometries.innerText()))
      .toBeGreaterThan(4);
    const builtinCount = Number(await geometries.innerText());
    const builtinTextures = Number(await textures.innerText());
    const resources: {
      appearance: string;
      geometries: number;
      textures: number;
    }[] = [];
    async function sample(appearance: string) {
      const reading = {
        appearance,
        geometries: Number(await geometries.innerText()),
        textures: Number(await textures.innerText()),
      };
      resources.push(reading);
      writeFileSync(
        'test-results/lab-foundation/t09-resource-counts.json',
        JSON.stringify(resources, null, 2),
      );
      return reading;
    }
    async function appearance(representation: string) {
      await showEntityDetails(page);
      await inspector
        .getByRole('button', { name: '更换外观', exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByLabel('外观表示')
        .selectOption(representation);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '保存', exact: true })
        .click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect
        .poll(async () => (await get(path)).representation_id)
        .toBe(representation || null);
    }
    // Hold the real file download to observe replacement loading before it resolves.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const waiting = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route(`**/assets/${draco.id}/download`, async (route) => {
      requested();
      await held;
      try {
        await route.continue();
      } catch (error) {
        if (!route.request().failure()) throw error;
      }
    });
    await appearance(draco.representation.id);
    await waiting;
    try {
      await expect(page.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'true',
      );
    } finally {
      release();
    }
    await page.unrouteAll({ behavior: 'wait' });
    await expect
      .poll(async () => Number(await geometries.innerText()))
      .toBeLessThan(builtinCount);
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const dracoCount = Number(await geometries.innerText());
    await expect(textures).toHaveText(String(builtinTextures));
    const dracoTextures = Number(await textures.innerText());
    await pixels(page, 't09-running-imported-canvas.png');
    await expect(
      page.getByRole('img', { name: /^Lifecycle centrifuge:/ }),
    ).toContainText('rpm');
    const replaced = await get(path);
    for (const field of [
      'id',
      'binding',
      'program_run',
      'configuration',
      'definition',
    ])
      expect(replaced[field]).toEqual(before[field]);
    expect(replaced.task.id).toBe(before.task.id);
    expect(replaced.task.parameters).toEqual(before.task.parameters);
    await expect
      .poll(async () => (await get(path)).task.status, { timeout: 20000 })
      .toBe('completed');
    const completed = await get(path);
    const task = await get(`${path}/tasks/${completed.task.id}`);
    const result = await get(`${path}/results/${completed.task.result_id}`);
    await appearance(basis.representation.id);
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect
      .poll(async () => Number(await textures.innerText()))
      .toBeGreaterThan(dracoTextures);
    const basisTextures = Number(await textures.innerText());
    await pixels(page, 't09-basis-canvas.png');
    let previousDraco = { geometries: dracoCount, textures: dracoTextures };
    let previousBasis = {
      geometries: Number(await geometries.innerText()),
      textures: basisTextures,
    };
    await sample('basis-initial');
    for (let i = 0; i < 3; i++) {
      await appearance(draco.representation.id);
      await expect(page.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect
        .poll(async () => Number(await geometries.innerText()))
        .toBeLessThanOrEqual(previousDraco.geometries);
      await expect(textures).toHaveText(String(dracoTextures));
      previousDraco = await sample(`draco-${i}`);
      await appearance(basis.representation.id);
      await expect(page.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect
        .poll(async () => Number(await geometries.innerText()))
        .toBeLessThanOrEqual(previousBasis.geometries);
      await expect(textures).toHaveText(String(basisTextures));
      previousBasis = await sample(`basis-${i}`);
    }
    await page.getByRole('tab', { name: '编辑布局', exact: true }).click();
    await inspector
      .getByRole('button', { name: '移除节点', exact: true })
      .click();
    await page.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect
      .poll(
        async () => (await get(`/api/v1/lab/labs/${lab}/world`)).nodes.length,
      )
      .toBe(0);
    await page.getByRole('checkbox', { name: '仅未放置对象' }).check();
    await expect(
      page.getByRole('button', { name: '选择 Lifecycle centrifuge' }),
    ).toBeVisible();
    await inspector.getByRole('button', { name: '新增同一对象表示' }).click();
    await page.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect
      .poll(
        async () => (await get(`/api/v1/lab/labs/${lab}/world`)).nodes.length,
      )
      .toBe(1);
    await page.getByRole('checkbox', { name: '仅未放置对象' }).uncheck();
    expect((await get(path)).id).toBe(entity);
    expect((await get(path)).task).toEqual(task);
    await page.getByRole('tab', { name: '运行查看', exact: true }).click();
    await showEntityOperations(page);
    await inspector
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    const stopped = await get(`${path}/runs/${before.program_run.id}`);
    await showEntityDetails(page);
    await inspector.getByRole('button', { name: '更换定义与程序' }).click();
    await page
      .getByRole('dialog')
      .getByLabel('定义版本')
      .selectOption('sensor@1.0');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '保存', exact: true })
      .click();
    await expect
      .poll(async () => (await get(path)).definition_id)
      .toBe('sensor');
    expect(await get(`${path}/runs/${before.program_run.id}`)).toEqual(stopped);
    expect(await get(`${path}/tasks/${task.id}`)).toEqual(task);
    expect(await get(`${path}/results/${result.id}`)).toEqual(result);
    await showEntityOperations(page);
    await inspector
      .getByRole('button', { name: '启动程序', exact: true })
      .click();
    await expect(
      page.getByRole('img', { name: /^Lifecycle centrifuge:/ }),
    ).toContainText('degC');
    await inspector
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    const bench = await agent.post(`/api/v1/lab/labs/${lab}/entities`, {
      data: {
        name: 'Active bench',
        definition_id: 'bench',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: {},
        representation_id: null,
      },
    });
    expect(bench.status()).toBe(201);
    await showEntityDetails(page);
    await inspector
      .getByRole('button', { name: '归档对象', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '归档', exact: true })
      .click();
    await expect(inspector.getByText('已归档', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: '已归档对象', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('img', { name: /^Lifecycle centrifuge:/ }),
    ).toHaveCount(0);
    const retainedWorld = await get(`/api/v1/lab/labs/${lab}/world`);
    expect(
      retainedWorld.nodes.some(
        (node: { entity_id: string }) => node.entity_id === entity,
      ),
    ).toBe(true);
    expect(
      (await agent.delete(`/api/v1/lab/assets/${basis.id}`)).status(),
    ).toBe(409);
    await pixels(page, 't09-archive-desktop-canvas.png');
    await page.screenshot({
      path: 'test-results/lab-foundation/t09-archive-desktop-zh.png',
      fullPage: true,
    });
    if (!desktopMigration)
      await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await showEntityDetails(page);
    await pixels(
      page,
      `t09-archive-${desktopMigration ? 'desktop' : 'mobile'}-canvas.png`,
    );
    const mobileInspector = page.getByRole('complementary', {
      name: 'Object info',
    });
    await mobileInspector
      .getByRole('heading', { name: 'Entity lifecycle' })
      .scrollIntoViewIfNeeded();
    await expect(
      mobileInspector.getByRole('button', { name: 'Replace appearance' }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/lab-foundation/t09-archive-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
      fullPage: true,
    });
    const exampleResponse = await agent.post(
      `/api/v1/lab/labs/${lab}/entities`,
      {
        data: {
          name: 'Tutorial device',
          definition_id: 'light',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
          representation_id: null,
        },
      },
    );
    expect(exampleResponse.status()).toBe(201);
    const example = await exampleResponse.json();
    const output = JSON.parse(
      execFileSync('node', ['examples/lab/manage-entity.mjs'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          LAB_API_BASE: process.env.E2E_API_URL,
          LAB_API_KEY: credential.secret,
          LAB_ID: lab,
          LAB_ENTITY_ID: example.id,
          LAB_REPRESENTATION_ID: draco.representation.id,
          LAB_ASSET_ID: draco.id,
        },
      }),
    );
    expect(output.entity).toBe(example.id);
    expect(output.archived_at).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await agent.dispose();
  }
});
