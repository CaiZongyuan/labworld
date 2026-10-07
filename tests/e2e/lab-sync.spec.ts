import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  createApiClient,
  subscribeLabWorld,
  type LabWorld,
} from '../../packages/sdk/src/index';

const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });
test('two browsers and an Agent recover the same world and revoked Agent access ends', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`sync-${Date.now()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('sync-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Shared sync lab');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption('light@1.0');
  await dialog.getByLabel('名称', { exact: true }).fill('Shared light');
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  await inspector
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await inspector.getByRole('switch', { name: '电源', exact: true }).click();
  await expect(
    inspector.getByRole('switch', { name: '电源', exact: true }),
  ).toBeChecked();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const headers = {
    origin: process.env.E2E_WEB_URL!,
    'x-csrf-token': session.csrf_token,
  };
  const labs = await (await page.request.get('/api/v1/lab/labs')).json();
  const lab = labs.data.find(
    (entry: { name: string }) => entry.name === 'Shared sync lab',
  ).id;
  const path = `/api/v1/lab/labs/${lab}`;
  const keyResponse = await page.request.post('/api/v1/api-keys', {
    headers,
    data: { name: 'Sync Agent', scopes: ['lab:full'], expires_in_days: 1 },
  });
  expect(keyResponse.status()).toBe(201);
  const credential = await keyResponse.json();
  const agentAbort = new AbortController();
  let agentWorld: LabWorld | undefined;
  let accessEnded = false;
  const agent = subscribeLabWorld({
    client: createApiClient(process.env.E2E_API_URL!),
    labId: lab,
    headers: { authorization: `Bearer ${credential.secret}` },
    signal: agentAbort.signal,
    onWorld: (world) => {
      agentWorld = world;
    },
    onEvent: (event) => {
      if (event.type === 'access_ended') accessEnded = true;
    },
  });
  const second = await browser.newContext({
    storageState: await page.context().storageState(),
    locale: 'zh-CN',
  });
  const observer = await second.newPage();
  observer.on('pageerror', (error) => errors.push(error.name));
  try {
    await observer.goto('/lab');
    await observer
      .getByRole('combobox', { name: '打开 Lab' })
      .selectOption(lab);
    await observer
      .getByRole('button', { name: '选择 Shared light', exact: true })
      .click();
    const other = observer
      .getByRole('complementary', { name: '对象信息' })
      .getByRole('switch', { name: '电源', exact: true });
    await expect(other).toBeChecked();
    await expect(observer.locator('canvas')).toBeVisible();
    await expect(observer.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await expect
      .poll(() => agentWorld?.entities[0].observation?.values)
      .toEqual(expect.objectContaining({ on: true }));
    await second.setOffline(true);
    // Offline is an explicit network boundary; the last complete world remains visible.
    await observer.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(observer.getByText('连接中断', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    expect(await other.isChecked()).toBe(true);
    await inspector.getByRole('switch', { name: '电源', exact: true }).click();
    await expect(
      inspector.getByRole('switch', { name: '电源', exact: true }),
    ).not.toBeChecked();
    await expect
      .poll(() => agentWorld?.entities[0].observation?.values)
      .toEqual(expect.objectContaining({ on: false }));
    await second.setOffline(false);
    await expect(other).not.toBeChecked();
    await expect(observer.getByText('实时同步', { exact: true })).toBeVisible();
    const authoritative = await (
      await page.request.get(`${path}/world`)
    ).json();
    await expect(page.getByLabel('世界版本')).toHaveText(
      `W${authoritative.version}`,
    );
    await expect(observer.getByLabel('世界版本')).toHaveText(
      `W${authoritative.version}`,
    );
    await expect.poll(() => agentWorld?.version).toBe(authoritative.version);
    expect(agentWorld).toEqual(authoritative);
    const script = JSON.parse(
      execFileSync(
        process.execPath,
        ['examples/lab/observe-world.mjs', '--once'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            LAB_API_BASE: process.env.E2E_API_URL,
            LAB_ID: lab,
            LAB_API_KEY: credential.secret,
          },
        },
      ),
    );
    expect(script.type).toBe('snapshot');
    expect(script.version).toBe(authoritative.version);
    await observer.screenshot({
      path: 'test-results/lab-foundation/t07-sync-desktop.png',
      fullPage: true,
    });
    await expect(page.locator('canvas')).toBeVisible();
    await expect(observer.locator('canvas')).toBeVisible();
    const screenshot = await observer
      .locator('canvas')
      .screenshot({ path: '/tmp/lab-sync-canvas.png' });
    const pixels = await observer.evaluate(async (encoded) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      let colors = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] + data[i + 1] + data[i + 2] > 100) colors++;
      return colors;
    }, screenshot.toString('base64'));
    expect(pixels).toBeGreaterThan(1000);
    expect(
      (
        await page.request.delete(`/api/v1/api-keys/${credential.key.id}`, {
          headers,
        })
      ).status(),
    ).toBe(204);
    await expect.poll(() => accessEnded).toBe(true);
    await agent;
    if (!desktopMigration)
      await observer.setViewportSize({ width: 320, height: 900 });
    await observer
      .getByRole('button', { name: 'English', exact: true })
      .click();
    await observer.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(observer.getByText('Live', { exact: true })).toBeVisible();
    await observer.screenshot({
      path: `test-results/lab-foundation/t07-sync-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
      fullPage: true,
    });
    expect(
      await observer.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    agentAbort.abort();
    await agent;
    await second.close();
  }
});
