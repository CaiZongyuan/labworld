import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { member, world as readWorld } from './lab-foundation-support';

const evidence =
  process.env.LAB_OPERATIONS_EVIDENCE ??
  '.scratch/37-vnext-operations/application';
mkdirSync(evidence, { recursive: true });
test.use({ locale: 'zh-CN' });
test.afterEach(async ({ page }, info) => {
  writeFileSync(
    join(evidence, 'assertions.json'),
    JSON.stringify(
      {
        status: info.status,
        positions: info.errors.flatMap(
          (error) =>
            error.stack?.match(/lab-operations\.spec\.ts:\d+:\d+/g) ?? [],
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
  await dialog.getByLabel('身份来源').selectOption('simulated');
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function clickTarget(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
  expect(
    await locator.evaluate((element) => {
      const r = element.getBoundingClientRect(),
        hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === element || (!!hit && element.contains(hit));
    }),
  ).toBe(true);
}

test('operations overview shares real device facts, trends, activity and recovery with another browser and Agent', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  const { agent } = await member(page);
  const secondContext = await browser.newContext({
    storageState: await page.context().storageState(),
    locale: 'zh-CN',
  });
  try {
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('名称', { exact: true })
      .fill('Operations acceptance Lab');
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(
      page.getByRole('heading', {
        name: 'Operations acceptance Lab',
        exact: true,
      }),
    ).toBeVisible();
    const labId = new URL(page.url()).searchParams.get('lab')!;
    for (const [definition, name] of [
      ['bench', 'Registered bench'],
      ['environment', 'Registered room'],
      ['light', 'Operations light'],
      ['sensor', 'Environment A'],
      ['sensor', 'Environment B'],
      ['centrifuge', 'Operations centrifuge'],
    ])
      await register(page, definition, name);
    let world = await readWorld(agent, labId);
    const byName = (name: string) =>
      world.entities.find((entity) => entity.name === name)!;
    const light = byName('Operations light'),
      sensorA = byName('Environment A'),
      sensorB = byName('Environment B'),
      centrifuge = byName('Operations centrifuge'),
      bench = byName('Registered bench'),
      room = byName('Registered room');
    const placement = {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    for (const x of [0, 1])
      expect(
        (
          await agent.post(`/api/v1/lab/labs/${labId}/nodes`, {
            data: {
              entity_id: light.id,
              placement: { ...placement, position: [x, 0, 0] },
            },
          })
        ).status(),
      ).toBe(201);
    world = await readWorld(agent, labId);
    expect(
      (
        await agent.put(`/api/v1/lab/labs/${labId}/layout`, {
          data: {
            expected_version: world.lab.layout_version,
            nodes: world.nodes
              .filter((node) => node.entity_id !== sensorB.id)
              .map(({ id, entity_id, representation_id, placement }) => ({
                id,
                entity_id,
                representation_id,
                placement,
              })),
            relationships: [
              {
                id: crypto.randomUUID(),
                source_id: bench.id,
                target_id: light.id,
                kind: 'contains',
              },
              {
                id: crypto.randomUUID(),
                source_id: bench.id,
                target_id: room.id,
                kind: 'located_in',
              },
            ],
          },
        })
      ).status(),
    ).toBe(200);
    for (const entity of [light, sensorA, sensorB, centrifuge])
      expect(
        (
          await agent.post(
            `/api/v1/lab/labs/${labId}/entities/${entity.id}/program/start`,
          )
        ).status(),
      ).toBe(201);
    for (const [capability, parameters] of [
      ['light.set_power', { on: false }],
      ['light.set_brightness', { brightness: 0 }],
    ] as const) {
      const response = await agent.post(
        `/api/v1/lab/labs/${labId}/entities/${light.id}/actions`,
        {
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          data: { capability, parameters },
        },
      );
      expect(response.status()).toBe(202);
    }
    await expect
      .poll(async () => {
        const current = await readWorld(agent, labId);
        return current.entities.filter((entity) => entity.observation).length;
      })
      .toBe(4);
    await page.goto(`/lab?lab=${labId}&view=overview`);
    const summary = page.getByRole('region', { name: '运行汇总' });
    await expect(
      summary.getByRole('button', { name: '已登记设备 4', exact: true }),
    ).toBeVisible();
    await expect(
      summary.getByRole('button', { name: '进行中任务 0', exact: true }),
    ).toBeVisible();
    await expect(
      summary.getByRole('button', { name: '当前有效观测 4', exact: true }),
    ).toBeVisible();
    await expect(
      summary.getByRole('button', { name: '待关注设备 0', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: '最近活动' })
        .locator(':scope > ol > li'),
    ).not.toHaveCount(0);
    const chart = page.locator('.operations-view .entity-trends svg').first();
    await expect(chart).toBeVisible();
    await page.getByLabel('环境传感器').selectOption(sensorB.id);
    await expect(page.locator('.operations-view .entity-trends')).toContainText(
      'degC',
    );
    await chart.screenshot({ path: join(evidence, 'environment-trend.png') });
    await page.screenshot({
      path: join(evidence, 'overview-1440.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.screenshot({
      path: join(evidence, 'overview-1920.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await summary
      .getByRole('button', { name: '已登记设备 4', exact: true })
      .click();
    await page.getByLabel('登记区域', { exact: true }).selectOption(room.id);
    const directory = page.getByRole('region', { name: '设备目录' });
    await expect(
      directory.getByRole('button', {
        name: '选择 Operations light',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      directory.getByRole('button', {
        name: '选择 Environment A',
        exact: true,
      }),
    ).toHaveCount(0);
    await page.getByLabel('搜索名称或身份').fill(light.id.slice(0, 8));
    const select = directory.getByRole('button', {
      name: '选择 Operations light',
      exact: true,
    });
    await select.click();
    const detail = page.getByRole('complementary', { name: '对象信息' });
    await expect(detail).toContainText(light.id);
    await detail.getByRole('switch', { name: '电源', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await readWorld(agent, labId)).entities.find(
            (entity) => entity.id === light.id,
          )?.observation?.properties.on.value,
      )
      .toBe(true);
    const second = await secondContext.newPage();
    await second.goto(
      `${process.env.E2E_WEB_URL}/lab?lab=${labId}&view=devices&entity=${light.id}`,
    );
    await expect(
      second
        .getByRole('complementary', { name: '对象信息' })
        .getByRole('region', { name: '观测电源' }),
    ).toContainText('开启');
    await page.reload();
    await expect(
      page.getByRole('tab', { name: '设备', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('complementary', { name: '对象信息' }),
    ).toContainText(light.id);
    await page
      .getByRole('button', { name: '关闭对象信息', exact: true })
      .click();
    await page.getByLabel('搜索名称或身份').fill(light.id.slice(0, 8));
    await page.context().setOffline(true);
    await expect(
      page.getByText('最后同步快照 · 只读', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '登记对象', exact: true }),
    ).toBeDisabled();
    await page.context().setOffline(false);
    await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
    await expect(page.getByLabel('搜索名称或身份')).toHaveValue(
      light.id.slice(0, 8),
    );
    await page.getByRole('tab', { name: '运行总览', exact: true }).click();
    await page.getByLabel('环境传感器').selectOption(sensorB.id);
    await expect(page.getByLabel('环境传感器')).toHaveValue(sensorB.id);
    const recent = page.getByRole('region', { name: '最近活动' });
    await expect(recent.locator(':scope > ol > li')).not.toHaveCount(0);
    await recent
      .getByRole('button', { name: /打开原对象/ })
      .first()
      .click();
    await expect(
      page
        .getByRole('complementary', { name: '对象信息' })
        .getByRole('region', { name: '原始记录结果' }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '运行总览', exact: true }).click();
    await page
      .getByRole('button', { name: '关闭对象信息', exact: true })
      .click();
    const widths = [];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (width === 320) {
        await page
          .getByRole('button', { name: 'English', exact: true })
          .click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      const target = page.getByRole('button', {
        name: width === 390 ? '已登记设备 4' : 'Registered devices 4',
        exact: true,
      });
      await clickTarget(target);
      widths.push(
        await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })),
      );
      await page.screenshot({
        path: join(evidence, `overview-${width}.png`),
        animations: 'disabled',
      });
    }
    expect(widths.every((value) => value.scrollWidth <= value.width)).toBe(
      true,
    );
    writeFileSync(
      join(evidence, 'geometry.json'),
      JSON.stringify(
        {
          widths,
          deviceIds: [light.id, sensorA.id, sensorB.id, centrifuge.id],
          deduplicatedNodes: world.nodes.filter(
            (node) => node.entity_id === light.id,
          ).length,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.context().setOffline(false);
    await secondContext.close();
    await agent.dispose();
  }
});

test('focused narrow overview keeps all four work tabs and device text within the agreed viewport', async ({
  page,
}) => {
  test.setTimeout(90000);
  const { agent } = await member(page);
  try {
    const response = await agent.post('/api/v1/lab/labs', {
      data: { name: 'Operations acceptance Lab' },
    });
    expect(response.status()).toBe(201);
    const labId = (await response.json()).id;
    for (const [definition, name] of [
      ['light', 'Operations light'],
      ['sensor', 'Environment A'],
      ['sensor', 'Environment B'],
      ['centrifuge', 'Operations centrifuge'],
    ]) {
      const response = await agent.post(`/api/v1/lab/labs/${labId}/entities`, {
        data: {
          name,
          definition_id: definition,
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
        },
      });
      expect(response.status()).toBe(201);
      const entity = await response.json();
      expect(
        (
          await agent.post(
            `/api/v1/lab/labs/${labId}/entities/${entity.id}/program/start`,
          )
        ).status(),
      ).toBe(201);
      if (definition === 'light')
        for (const [capability, parameters] of [
          ['light.set_power', { on: false }],
          ['light.set_brightness', { brightness: 0 }],
        ] as const)
          expect(
            (
              await agent.post(
                `/api/v1/lab/labs/${labId}/entities/${entity.id}/actions`,
                {
                  headers: { 'Idempotency-Key': crypto.randomUUID() },
                  data: { capability, parameters },
                },
              )
            ).status(),
          ).toBe(202);
    }
    await page.goto(`/lab?lab=${labId}&view=overview`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(
      page.getByRole('button', { name: '已登记设备 4', exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.operations-view .entity-trends svg').first(),
    ).toBeVisible({ timeout: 15000 });
    await page
      .getByRole('button', { name: '已登记设备 4', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(evidence, 'overview-top-1440.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.screenshot({
      path: join(evidence, 'overview-top-1920.png'),
      animations: 'disabled',
    });
    const geometry = [];
    for (const width of [390, 320]) {
      if (width === 320) {
        await page
          .getByRole('button', { name: 'English', exact: true })
          .click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      await page.setViewportSize({ width, height: 844 });
      const names =
        width === 390
          ? ['三维空间', '运行总览', '设备', '运行记录']
          : ['3D space', 'Overview', 'Devices', 'Lab records'];
      for (const name of names)
        await clickTarget(page.getByRole('tab', { name, exact: true }));
      const target = page.getByRole('button', {
        name: width === 390 ? '已登记设备 4' : 'Registered devices 4',
        exact: true,
      });
      await clickTarget(target);
      const table = page.getByRole('table').first();
      const keyHeader = table.getByRole('columnheader', {
        name: width === 390 ? '关键读数' : 'Key readings',
        exact: true,
      });
      const tableBox = await table.boundingBox();
      expect(tableBox).not.toBeNull();
      const headerBox = await keyHeader.boundingBox();
      expect(headerBox).not.toBeNull();
      const metrics = {
        ...(await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }))),
        tableWidth: tableBox!.width,
        keyHeaderWidth: headerBox!.width,
      };
      geometry.push(metrics);
      writeFileSync(
        join(evidence, 'narrow-geometry.json'),
        JSON.stringify(geometry, null, 2),
      );
      expect(metrics.scrollWidth).toBeLessThanOrEqual(width);
      expect(metrics.tableWidth).toBeGreaterThanOrEqual(560);
      expect(metrics.keyHeaderWidth).toBeGreaterThan(60);
      await page.screenshot({
        path: join(evidence, `narrow-overview-${width}.png`),
        animations: 'disabled',
      });
      await target.click();
      await expect(
        page.getByRole('tab', {
          name: width === 390 ? '设备' : 'Devices',
          exact: true,
        }),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(
        page
          .getByRole('region', {
            name: width === 390 ? '设备目录' : 'Device directory',
          })
          .getByRole('button', {
            name:
              width === 390
                ? '选择 Operations light'
                : 'Select Operations light',
            exact: true,
          }),
      ).toBeVisible();
      await page
        .getByRole('tab', {
          name: width === 390 ? '运行总览' : 'Overview',
          exact: true,
        })
        .click();
    }
  } finally {
    await agent.dispose();
  }
});
