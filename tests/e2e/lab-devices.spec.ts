import { showObjectDirectory } from './lab-desktop';
import {
  expect,
  test,
  request as playwrightRequest,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DeviceProgramRun,
  LabEntity,
  LabWorld,
} from '../../packages/contracts/src/generated/types.gen';
const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });
async function pixelChange(page: Page, before: Buffer, after: Buffer) {
  return page.evaluate(
    async (images) => {
      const arrays = await Promise.all(
        images.map(async (encoded) => {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return {
            data: context.getImageData(0, 0, image.width, image.height).data,
            width: image.width,
            height: image.height,
          };
        }),
      );
      let count = 0,
        left = arrays[0].width,
        right = 0,
        top = arrays[0].height,
        bottom = 0;
      for (let i = 0; i < arrays[0].data.length; i += 4)
        if (
          Math.abs(arrays[0].data[i] - arrays[1].data[i]) +
            Math.abs(arrays[0].data[i + 1] - arrays[1].data[i + 1]) +
            Math.abs(arrays[0].data[i + 2] - arrays[1].data[i + 2]) >
          30
        ) {
          const x = (i / 4) % arrays[0].width,
            y = Math.floor(i / 4 / arrays[0].width);
          count++;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      return { count, left, right, top, bottom };
    },
    [before.toString('base64'), after.toString('base64')],
  );
}
test('two backend lights report independent pixels to a Member and an Agent after every page closes', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`lighting-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('lighting-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Backend lighting lab');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Backend lighting lab', exact: true }),
  ).toBeVisible();
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  const ids: string[] = [];
  let lab = '';
  const readinessStarted = performance.now();
  const responseFacts: Record<string, unknown>[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.endsWith('/world') && !path.endsWith('/program/start')) return;
    const fact: Record<string, unknown> = {
      order: responseFacts.length,
      seenAtMs: performance.now() - readinessStarted,
      path,
      status: response.status(),
    };
    responseFacts.push(fact);
    if (!response.ok()) return;
    void (async () => {
      try {
        if (path.endsWith('/world')) {
          const world = (await response.json()) as LabWorld;
          fact.version = world.version;
          fact.entities = world.entities.map((entity) => ({
            id: entity.id,
            run: entity.program_run
              ? { id: entity.program_run.id, status: entity.program_run.status }
              : null,
            capabilities: entity.capabilities.map((capability) => ({
              id: capability.id,
              executable: capability.executable,
              reason: capability.reason,
            })),
          }));
        } else {
          const run = (await response.json()) as DeviceProgramRun;
          fact.run = { id: run.id, status: run.status };
        }
        fact.parsedAtMs = performance.now() - readinessStarted;
      } catch {
        fact.bodyAvailable = false;
      }
    })();
  });
  for (const name of ['Light A', 'Light B']) {
    await page.getByRole('button', { name: '登记对象', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('定义版本').selectOption('light@1.0');
    await dialog.getByLabel('名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '登记', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `选择 ${name}`, exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByText('未知 · 无观测', { exact: true }),
    ).toBeVisible();
    ids.push(
      await inspector
        .locator('dt')
        .filter({ hasText: /^Entity$/ })
        .locator('+ dd')
        .innerText(),
    );
    lab = await inspector
      .locator('dt')
      .filter({ hasText: /^Lab$/ })
      .locator('+ dd')
      .innerText();
    await inspector
      .getByRole('button', { name: '启动程序', exact: true })
      .click();
    let enableFailed = false;
    try {
      await expect(
        inspector.getByRole('switch', { name: '电源', exact: true }),
      ).toBeEnabled();
    } catch (error) {
      enableFailed = true;
      throw error;
    } finally {
      if (enableFailed)
        await (async () => {
          const assertionEndedAtMs = performance.now() - readinessStarted;
          const dom = await inspector
            .evaluate(
              (root) => {
                const entity = Array.from(root.querySelectorAll('dt')).find(
                  (entry) => entry.textContent === 'Entity',
                )?.nextElementSibling?.textContent;
                const world = document.querySelector(
                  '[aria-label="世界版本"]',
                )?.textContent;
                const switches = Array.from(
                  root.querySelectorAll('[role="switch"]'),
                );
                const programs = Array.from(
                  root.querySelectorAll('button'),
                ).filter((button) =>
                  /^(启动程序|停止程序)$/.test(
                    button.textContent?.trim() ?? '',
                  ),
                );
                const known = [
                  '运行端尚未就绪',
                  '操作未完成',
                  '实时同步',
                  '正在连接',
                  '连接中断',
                  '访问已结束',
                ];
                const visible = Array.from(document.querySelectorAll('*'))
                  .filter(
                    (element) =>
                      element.children.length === 0 &&
                      known.includes(element.textContent ?? '') &&
                      element.getClientRects().length > 0 &&
                      getComputedStyle(element).visibility === 'visible',
                  )
                  .map((element) => element.textContent);
                return {
                  selectedEntityId: /^[0-9a-f-]{36}$/i.test(entity ?? '')
                    ? entity
                    : null,
                  worldLabel: /^W\d+$/.test(world ?? '') ? world : null,
                  switchCount: switches.length,
                  switch:
                    switches.length === 1
                      ? {
                          nativeEnabled: !(switches[0] as HTMLButtonElement)
                            .disabled,
                          ariaDisabled:
                            switches[0].getAttribute('aria-disabled'),
                          dataDisabled:
                            switches[0].hasAttribute('data-disabled'),
                        }
                      : null,
                  program: programs.map((button) => ({
                    label: button.textContent?.trim(),
                    enabled: !button.disabled,
                  })),
                  runtimeAlert: visible.includes('运行端尚未就绪'),
                  errorVisible: visible.includes('操作未完成'),
                  sync: visible.filter(
                    (label) =>
                      !['运行端尚未就绪', '操作未完成'].includes(label ?? ''),
                  ),
                };
              },
              undefined,
              { timeout: 250 },
            )
            .catch(() => null);
          await writeFile(
            join(process.env.LAB_NODE_EVIDENCE!, 'light-start-facts.json'),
            JSON.stringify({
              assertionEndedAtMs,
              capturedAtMs: performance.now() - readinessStarted,
              requestedEntityId: ids.at(-1),
              dom,
              responses: responseFacts,
            }) + '\n',
          );
        })().catch(() => {
          // Optional diagnostics must preserve the original assertion failure.
        });
    }
  }
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const credential = await page.request.post('/api/v1/api-keys', {
    headers: {
      origin: process.env.E2E_WEB_URL!,
      'x-csrf-token': session.csrf_token,
    },
    data: {
      name: 'Browser lighting Agent',
      scopes: ['lab:full'],
      expires_in_days: 1,
    },
  });
  expect(credential.status()).toBe(201);
  const token = (await credential.json()).secret;
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  async function apply(
    id: string,
    capability: string,
    parameters: Record<string, unknown>,
  ) {
    const path = `/api/v1/lab/labs/${lab}/entities/${id}`;
    const key = crypto.randomUUID();
    const accepted = await agent.post(`${path}/actions`, {
      headers: { 'Idempotency-Key': key },
      data: { capability, parameters },
    });
    expect(accepted.status()).toBe(202);
    const command = await accepted.json();
    await expect
      .poll(
        async () =>
          (await (await agent.get(`${path}/commands/${command.id}`)).json())
            .status,
      )
      .toBe('succeeded');
    const retry = await agent.post(`${path}/actions`, {
      headers: { 'Idempotency-Key': key },
      data: { capability, parameters },
    });
    expect((await retry.json()).id).toBe(command.id);
  }
  try {
    await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
    for (const id of ids) await apply(id, 'light.set_power', { on: false });
    await page
      .getByRole('button', { name: '选择 Light A', exact: true })
      .click();
    await expect(
      inspector.getByText('观测电源', { exact: true }),
    ).toBeVisible();
    await expect(
      inspector.getByRole('switch', { name: '电源' }),
    ).not.toBeChecked();
    const off = await page.locator('canvas').screenshot();
    await inspector.getByRole('switch', { name: '电源' }).click();
    await expect(inspector.getByRole('switch', { name: '电源' })).toBeChecked();
    await expect(
      inspector.getByText('执行完成', { exact: true }),
    ).toBeVisible();
    const aOn = await page.locator('canvas').screenshot();
    const changedA = await pixelChange(page, off, aOn);
    expect(changedA.count).toBeGreaterThan(30);
    await apply(ids[1], 'light.set_power', { on: true });
    await expect
      .poll(async () => {
        const before = await page.locator('canvas').screenshot();
        return (await pixelChange(page, aOn, before)).count;
      })
      .toBeGreaterThan(30);
    const bothOn = await page.locator('canvas').screenshot();
    const changedB = await pixelChange(page, aOn, bothOn);
    expect(
      changedB.right < changedA.left || changedA.right < changedB.left,
    ).toBe(true);
    await inspector.getByLabel('目标亮度 (%)').fill('35');
    await inspector.getByRole('button', { name: '设置', exact: true }).click();
    await expect(inspector.getByText('35 %', { exact: true })).toBeVisible();
    const world = await (
      await agent.get(`/api/v1/lab/labs/${lab}/world`)
    ).json();
    expect(
      world.entities.find((entity: { id: string }) => entity.id === ids[0])
        .observation.values,
    ).toEqual({ on: true, brightness: 35 });
    expect(
      world.entities.find((entity: { id: string }) => entity.id === ids[1])
        .observation.values,
    ).toEqual({ on: true, brightness: 100 });
    await page.screenshot({
      path: 'test-results/lab-foundation/t03-lights-desktop.png',
      fullPage: true,
    });
    const context = page.context();
    await page.close();
    await apply(ids[1], 'light.set_brightness', { brightness: 20 });
    const reopened = await context.newPage();
    reopened.on('pageerror', (error) => errors.push(error.name));
    await reopened.goto('/lab');
    await reopened
      .getByRole('combobox', { name: '打开 Lab' })
      .selectOption(lab);
    await showObjectDirectory(reopened);
    await reopened
      .getByRole('button', { name: '选择 Light B', exact: true })
      .click();
    const reopenedInspector = reopened.getByRole('complementary', {
      name: '对象信息',
    });
    await expect(
      reopenedInspector.getByText('20 %', { exact: true }),
    ).toBeVisible();
    await reopened
      .getByRole('button', { name: '选择 Light A', exact: true })
      .click();
    await reopenedInspector
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    await expect(
      reopenedInspector.getByRole('button', { name: '启动程序', exact: true }),
    ).toBeVisible();
    await expect(
      reopenedInspector.getByText('35 %', { exact: true }),
    ).toBeVisible();
    await expect(
      reopenedInspector.getByRole('switch', { name: '电源' }),
    ).toBeDisabled();
    const stopped = (await (
      await agent.get(`/api/v1/lab/labs/${lab}/entities/${ids[0]}`)
    ).json()) as LabEntity;
    const originalA = (world as LabWorld).entities.find(
      (entity) => entity.id === ids[0],
    )!;
    expect(stopped.program_run!.id).toBe(originalA.program_run!.id);
    expect(stopped.program_run!.status).toBe('stopped');
    expect(stopped.observation!.run_id).toBe(originalA.observation!.run_id);
    expect(stopped.observation!.values).toEqual(originalA.observation!.values);
    for (const [name, property] of Object.entries(
      originalA.observation!.properties,
    )) {
      const retained = stopped.observation!.properties[name];
      expect({ ...retained, freshness: property.freshness }).toEqual(property);
    }
    expect(stopped.observation!.freshness).toBe(
      Object.values(stopped.observation!.properties).some(
        (property) => property.freshness === 'stale',
      )
        ? 'stale'
        : 'stopped',
    );
    const invalid = await agent.post(
      `/api/v1/lab/labs/${lab}/entities/${ids[0]}/actions`,
      {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { capability: 'light.set_power', parameters: { on: false } },
      },
    );
    expect(invalid.status()).toBe(422);
    expect((await invalid.json()).error.code).toBe('lab.program_not_running');
    const tutorial = JSON.parse(
      execFileSync(process.execPath, ['examples/lab/control-lights.mjs'], {
        env: {
          ...process.env,
          LAB_API_BASE: process.env.E2E_API_URL,
          LAB_API_KEY: token,
        },
        encoding: 'utf8',
      }),
    );
    expect(tutorial.values).toEqual([
      { on: true, brightness: 35 },
      { on: true, brightness: 20 },
    ]);
    if (!desktopMigration)
      await reopened.setViewportSize({ width: 390, height: 844 });
    await reopened.evaluate(() => {
      localStorage.setItem('labos-threejs.locale', 'en');
      localStorage.setItem('labos-threejs.theme', 'dark');
    });
    await reopened.reload();
    await reopened
      .getByRole('combobox', { name: 'Open Lab' })
      .selectOption(lab);
    await showObjectDirectory(reopened);
    await reopened
      .getByRole('button', { name: 'Select Light B', exact: true })
      .click();
    await reopened.locator('canvas').scrollIntoViewIfNeeded();
    await reopened.screenshot({
      path: `test-results/lab-foundation/t03-lights-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
      fullPage: true,
    });
    await reopened
      .getByRole('complementary', { name: 'Object info' })
      .scrollIntoViewIfNeeded();
    await reopened.screenshot({
      path: `test-results/lab-foundation/t03-inspector-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
      fullPage: true,
    });
    expect(
      await reopened.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const mobileImage = await reopened.locator('canvas').screenshot();
    const colorCount = await reopened.evaluate(async (encoded) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const colors = new Set<string>();
      for (let i = 0; i < pixels.length; i += 20)
        colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      return colors.size;
    }, mobileImage.toString('base64'));
    expect(colorCount).toBeGreaterThan(30);
    expect(errors).toEqual([]);
    await reopened.close();
  } finally {
    await agent.dispose();
  }
});
