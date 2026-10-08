import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { showObjectDirectory } from './lab-desktop';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({ locale: 'zh-CN', colorScheme: 'light', actionTimeout: 10000 });

async function register(page: Page, email: string, password: string) {
  await page.goto('/register');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
}

async function createLab(page: Page, name: string) {
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/lab/labs',
  );
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return (await response.json()).id as string;
}

async function object(page: Page, definition: string, name: string) {
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/labs\/[^/]+\/entities$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  try {
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
  } catch (cause) {
    if (new URL(page.url()).pathname === '/lab')
      await page.screenshot({ path: 'test-results/layout-draft-setup.png' });
    throw cause;
  }
  return (await response.json()).id as string;
}

async function select(page: Page, name: string) {
  if (
    !(await page
      .getByRole('complementary', { name: /^(对象目录|Object directory)$/ })
      .isVisible())
  )
    await showObjectDirectory(page);
  await page.getByRole('button', { name: `选择 ${name}`, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function edit(page: Page) {
  await page.getByRole('tab', { name: /^(编辑布局|Edit layout)$/ }).click();
  const x = page.getByLabel('X (m)', { exact: true });
  await expect(x).toBeVisible();
  return x;
}

let saveAttempt = 0;
async function save(page: Page) {
  const attempt = ++saveAttempt;
  const location = new URL(page.url());
  const labId = location.searchParams.get('lab');
  const entityId = location.searchParams.get('entity');
  const action = page.getByRole('button', {
    name: /^(保存布局|重试保存|Save layout|Retry save)$/,
  });
  const status = page.getByRole('status', {
    name: /^(布局保存状态|Layout save status)$/,
  });
  const response = page
    .waitForResponse(
      (result) =>
        result.request().method() === 'PUT' &&
        new URL(result.url()).pathname === `/api/v1/lab/labs/${labId}/layout`,
      { timeout: 10000 },
    )
    .then(async (result) => {
      const body = await result.json().catch(() => null);
      const input = result.request().postDataJSON();
      return {
        status: result.status(),
        code: body?.error?.code ?? null,
        returnedVersion: body?.layout_version ?? null,
        expectedVersion: input?.expected_version ?? null,
      };
    })
    .catch(() => null);
  try {
    await action.click();
    await expect(status).toHaveText(/^(已保存|Saved)$/);
  } finally {
    const saved = labId
      ? await page.request
          .get(`/api/v1/lab/labs/${labId}/world`, { timeout: 5000 })
          .then(async (result) => {
            const body = result.ok() ? await result.json() : null;
            return {
              status: result.status(),
              layoutVersion: body?.lab?.layout_version ?? null,
              placements:
                body?.nodes
                  ?.filter(
                    (node: { entity_id: string }) =>
                      node.entity_id === entityId,
                  )
                  .map((node: { placement: unknown }) => node.placement) ?? [],
            };
          })
          .catch(() => null)
      : null;
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        `layout-draft-save-${attempt}.json`,
      ),
      JSON.stringify(
        {
          attempt,
          labId,
          entityId,
          response: await response,
          saved,
          uiStatus: await status
            .textContent({ timeout: 1000 })
            .catch(() => null),
          disabled: await action
            .isDisabled({ timeout: 1000 })
            .catch(() => null),
          rawX: await page
            .getByLabel('X (m)', { exact: true })
            .inputValue({ timeout: 1000 })
            .catch(() => null),
        },
        null,
        2,
      ),
    );
  }
}

async function world(page: Page, lab: string) {
  const response = await page.request.get(`/api/v1/lab/labs/${lab}/world`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function redHandle(page: Page) {
  const png = await page.locator('canvas').screenshot();
  return page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const points: { x: number; y: number }[] = [];
    for (let index = 0; index < pixels.length; index += 4)
      if (
        pixels[index] > 180 &&
        pixels[index] > pixels[index + 1] * 1.8 &&
        pixels[index] > pixels[index + 2] * 1.8
      )
        points.push({
          x: (index / 4) % image.width,
          y: Math.floor(index / 4 / image.width),
        });
    return {
      ...(points[Math.floor(points.length * 0.65)] ?? { x: 0, y: 0 }),
      count: points.length,
    };
  }, png.toString('base64'));
}

test('one browser recovers private layout input while other users and browsers share only saved World', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  const contexts: BrowserContext[] = [];
  const password = 'browser-layout-draft-password';
  const email = `draft-${Date.now()}@example.test`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  try {
    await register(page, email, password);
    const lab = await createLab(page, 'Browser drafts');
    const bench = await object(page, 'bench', 'Draft bench');
    const beaker = await object(page, 'labware', 'Draft beaker');
    await select(page, 'Draft beaker');
    await edit(page);
    await page.getByLabel('关系对象').selectOption(bench);
    await page.getByRole('button', { name: '登记关系', exact: true }).click();
    await save(page);
    const baseline = await world(page, lab);
    const nodeId = baseline.nodes.find(
      (node: { entity_id: string }) => node.entity_id === beaker,
    ).id;
    const placement = (snapshot: typeof baseline, entityId: string) =>
      snapshot.nodes.find(
        (node: { entity_id: string }) => node.entity_id === entityId,
      ).placement.position;
    const y = page.getByLabel('Y (m)', { exact: true });
    await y.fill('-');
    await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
    await page.getByRole('button', { name: '移动', exact: true }).click();
    await expect
      .poll(async () => (await redHandle(page)).count)
      .toBeGreaterThan(10);
    const beforeX = Number(
      await page.getByLabel('X (m)', { exact: true }).inputValue(),
    );
    const point = await redHandle(page),
      bounds = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(bounds.x + point.x, bounds.y + point.y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + point.x + 60, bounds.y + point.y, {
      steps: 12,
    });
    await page.mouse.up();
    await expect
      .poll(async () =>
        Number(await page.getByLabel('X (m)', { exact: true }).inputValue()),
      )
      .not.toBe(beforeX);
    await expect(y).toHaveValue('-');
    await expect(
      page.getByRole('button', { name: '保存布局', exact: true }),
    ).toBeDisabled();
    await y.fill('0');
    let x = page.getByLabel('X (m)', { exact: true });
    await x.fill('-');
    await page.reload();
    x = await edit(page);
    await expect(x).toHaveValue('-');
    await expect(
      page.getByRole('button', { name: '保存布局', exact: true }),
    ).toBeDisabled();
    expect((await world(page, lab)).lab.layout_version).toBe(
      baseline.lab.layout_version,
    );
    await x.press('End');
    await x.pressSequentially('.25');
    await expect(x).toHaveValue('-.25');
    await x.press('ArrowLeft');
    const cursor = await x.evaluate(
      (input: HTMLInputElement) => input.selectionStart,
    );
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(x).toHaveValue('-.25');
    expect(
      await x.evaluate((input: HTMLInputElement) => input.selectionStart),
    ).toBe(cursor);
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    await page.screenshot({ path: 'test-results/layout-draft-1440.png' });
    const url = page.url();
    const otherContext = await browser.newContext({
      baseURL: process.env.E2E_WEB_URL,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(otherContext);
    const other = await otherContext.newPage();
    await other.goto('/login');
    await other.getByLabel('邮箱', { exact: true }).fill(email);
    await other.getByLabel('密码', { exact: true }).fill(password);
    await other.getByRole('button', { name: '登录', exact: true }).click();
    await expect(other).toHaveURL(/\/lab$/);
    await other.goto(url);
    const otherX = await edit(other);
    await expect(otherX).toHaveValue(String(placement(baseline, beaker)[0]));
    await expect(
      other.getByRole('status', { name: '布局保存状态' }),
    ).toHaveText('布局已同步');
    await select(other, 'Draft bench');
    await other.getByLabel('X (m)', { exact: true }).fill('4');
    await save(other);
    await page.reload();
    x = await edit(page);
    await expect(x).toHaveValue('-.25');
    await expect(
      page.getByText('布局已改变，草稿已保留', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '重新载入并保留草稿', exact: true })
      .click();
    await save(page);
    const saved = await world(page, lab);
    expect(placement(saved, beaker)[0]).toBe(-0.25);
    expect(placement(saved, bench)[0]).toBe(4);
    expect(saved.relationships).toEqual(baseline.relationships);
    expect(
      saved.nodes.find((node: { id: string }) => node.id === nodeId).entity_id,
    ).toBe(beaker);
    await other.goto(url);
    await expect(await edit(other)).toHaveValue('-0.25');
    await otherContext.close();
    await page.getByLabel('X (m)', { exact: true }).fill('7');
    await page
      .getByRole('button', { name: '放弃草稿并重新载入', exact: true })
      .click();
    await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
      '布局已同步',
    );
    await page.reload();
    await expect(await edit(page)).toHaveValue('-0.25');
    expect((await world(page, lab)).lab.layout_version).toBe(
      saved.lab.layout_version,
    );
    await page.getByLabel('X (m)', { exact: true }).fill('5');
    const secondUserContext = await browser.newContext({
      baseURL: process.env.E2E_WEB_URL,
      locale: 'zh-CN',
    });
    contexts.push(secondUserContext);
    const secondUser = await secondUserContext.newPage();
    await register(
      secondUser,
      `draft-other-${Date.now()}@example.test`,
      password,
    );
    await secondUser.goto(url);
    await expect(await edit(secondUser)).toHaveValue('-0.25');
    await expect(
      secondUser.getByRole('status', { name: '布局保存状态' }),
    ).toHaveText('布局已同步');
    await secondUserContext.close();
    await createLab(page, 'Other draft Lab');
    await object(page, 'bench', 'Other bench');
    await select(page, 'Other bench');
    await expect(await edit(page)).toHaveValue('0');
    await page.getByLabel('打开 Lab').selectOption(lab);
    await select(page, 'Draft beaker');
    await expect(await edit(page)).toHaveValue('5');
    if (
      await page
        .getByRole('complementary', { name: '对象目录', exact: true })
        .isVisible()
    )
      await page
        .getByRole('button', { name: '关闭对象目录', exact: true })
        .click();
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 390, height: 844 },
      { width: 320, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      if (viewport.width === 320) {
        await page
          .getByRole('button', { name: 'English', exact: true })
          .click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      await expect(page.getByLabel('X (m)', { exact: true })).toBeVisible();
      await page.getByLabel('X (m)', { exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('5');
      await page
        .getByRole('button', { name: /^(聚焦模型|Fit model)$/ })
        .click();
      if (viewport.width === 320) {
        await page.locator('canvas').hover();
        await page.mouse.wheel(0, 1000);
      }
      const saveButton = page.getByRole('button', {
        name: /^(保存布局|Save layout)$/,
      });
      await expect(saveButton).toBeEnabled();
      await saveButton.focus();
      await expect(saveButton).toBeFocused();
      const geometry = await page.locator('canvas').evaluate((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + Math.min(60, rect.height / 2),
        );
        return {
          width: rect.width,
          height: rect.height,
          exposed: hit === canvas,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(geometry.width).toBeGreaterThan(150);
      expect(geometry.height).toBeGreaterThan(100);
      expect(geometry.exposed).toBe(true);
      expect(geometry.overflow).toBe(false);
      if (viewport.width < 560) {
        const rect = await saveButton.boundingBox();
        expect(rect!.width).toBeGreaterThanOrEqual(44);
        expect(rect!.height).toBeGreaterThanOrEqual(44);
      }
      await expect
        .poll(async () => (await redHandle(page)).count)
        .toBeGreaterThan(10);
      await page.screenshot({
        path: `test-results/layout-draft-${viewport.width}.png`,
      });
    }
    expect((await world(page, lab)).lab.layout_version).toBe(
      saved.lab.layout_version,
    );
    expect((await world(page, lab)).relationships).toEqual(
      baseline.relationships,
    );
  } catch (cause) {
    const location = new URL(page.url());
    if (location.pathname === '/lab') {
      await page
        .screenshot({ path: 'test-results/layout-draft-failure.png' })
        .catch(() => {});
      const windowState = await page
        .evaluate(() => ({
          language: document.documentElement.lang,
          dark: document.documentElement.classList.contains('dark'),
          canvasCount: document.querySelectorAll('canvas').length,
          dialogCount: document.querySelectorAll('[role="dialog"]').length,
        }))
        .catch(() => null);
      writeFileSync(
        'test-results/layout-draft-failure.json',
        JSON.stringify(
          {
            viewport: page.viewportSize(),
            path: location.pathname,
            lab: location.searchParams.get('lab'),
            entity: location.searchParams.get('entity'),
            windowState,
          },
          null,
          2,
        ),
      );
    }
    throw cause;
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
