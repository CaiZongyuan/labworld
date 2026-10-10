import {
  expect,
  test,
  request as playwrightRequest,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';

const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });
test.skip(
  process.env.LAB_OBSERVATION_RETENTION_SECS !== '2' ||
    process.env.LAB_RECORD_RETENTION_SECS !== '20',
  'Run the isolated history journey with observation retention 2 s and record retention 20 s.',
);
async function canvasPixels(page: Page, path: string) {
  const png = await page.locator('canvas').screenshot({ path });
  const colors = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return new Set(
      Array.from(
        { length: Math.floor(pixels.length / 16) },
        (_, index) =>
          `${pixels[index * 16] >> 4}:${pixels[index * 16 + 1] >> 4}:${pixels[index * 16 + 2] >> 4}`,
      ),
    ).size;
  }, png.toString('base64'));
  expect(colors).toBeGreaterThan(20);
}
test('members and Agents query real history, recover a failed page and clean expired records', async ({
  page,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`history-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('history-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('History lab');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  await page.getByRole('button', { name: '登记对象', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('定义版本').selectOption('centrifuge@1.0');
  await dialog.getByLabel('名称', { exact: true }).fill('History centrifuge');
  await dialog.getByRole('button', { name: '登记', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  await expect(
    inspector.getByRole('heading', { name: 'History centrifuge', exact: true }),
  ).toBeVisible();
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
  await inspector
    .getByRole('button', { name: '启动程序', exact: true })
    .click();
  await expect(
    inspector.getByRole('button', { name: '开始离心', exact: true }),
  ).toBeEnabled();
  await inspector.getByLabel('目标转速 (rpm)').fill('500');
  await inspector.getByLabel('目标温度 (degC)').fill('22');
  await inspector.getByLabel('任务时长 (s)').fill('6');
  await inspector
    .getByRole('button', { name: '开始离心', exact: true })
    .click();
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const credential = await (
    await page.request.post('/api/v1/api-keys', {
      headers: {
        origin: process.env.E2E_WEB_URL!,
        'x-csrf-token': session.csrf_token,
      },
      data: { name: 'History Agent', scopes: ['lab:full'], expires_in_days: 1 },
    })
  ).json();
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${credential.secret}` },
  });
  const get = async (url: string) => {
    const response = await agent.get(url);
    expect(response.status()).toBe(200);
    return response.json();
  };
  try {
    const policy = await get(`/api/v1/lab/labs/${lab}/history/retention`);
    expect(policy).toEqual({ observation_seconds: 2, record_seconds: 20 });
    await expect
      .poll(async () => (await get(path)).task?.status, { timeout: 20000 })
      .toBe('completed');
    const completed = await get(path);
    const originalCommand = await get(
      `${path}/commands/${completed.task.command_id}`,
    );
    await inspector.getByRole('tab', { name: '记录', exact: true }).click();
    const history = page.getByRole('region', { name: '运行历史' });
    await history.getByRole('tab', { name: '任务', exact: true }).click();
    await expect(history.getByText('已完成', { exact: true })).toBeVisible();
    await history.getByText('记录详情', { exact: true }).click();
    await expect(
      history.getByText(completed.task.id, { exact: true }),
    ).toBeVisible();
    const from = new Date(Date.now() - 3600000).toISOString(),
      to = new Date(Date.now() + 60000).toISOString();
    const query = (kind: string, cursor?: string) =>
      `${path}/history?${new URLSearchParams({ record_type: kind, from, to, limit: '1', ...(cursor ? { cursor } : {}) })}`;
    const events = await get(query('event'));
    expect(events.items).toHaveLength(1);
    expect(events.next_cursor).toBeTruthy();
    const next = await get(query('event', events.next_cursor));
    expect(next.items[0].id).not.toBe(events.items[0].id);
    const tasks = await get(query('task'));
    expect(tasks.items[0].data.id).toBe(completed.task.id);
    expect(tasks.items[0].data.result.status).toBe('completed');
    await canvasPixels(
      page,
      'test-results/lab-foundation/t08-history-desktop-canvas.png',
    );
    await page.screenshot({
      path: 'test-results/lab-foundation/t08-history-desktop-zh.png',
      fullPage: true,
    });
    await history.getByRole('tab', { name: '观测', exact: true }).click();
    // The panel's default end is fixed at opening; choose current bounds after render captures.
    const observationRange = await page.evaluate(() => {
      const now = Date.now();
      const localTime = (time: number) =>
        new Date(time - new Date(time).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
      const from = localTime(now - 3600000);
      const to = localTime(now + 5 * 60000);
      return {
        from,
        to,
        fromUtc: new Date(from).toISOString(),
        toUtc: new Date(to).toISOString(),
      };
    });
    await history.getByLabel('开始时间').fill(observationRange.from);
    await history.getByLabel('结束时间').fill(observationRange.to);
    const [currentHistory] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `${path}/history` &&
          url.searchParams.get('record_type') === 'observation' &&
          url.searchParams.get('from') === observationRange.fromUtc &&
          url.searchParams.get('to') === observationRange.toUtc
        );
      }),
      history.getByRole('button', { name: '查询历史', exact: true }).click(),
    ]);
    expect(currentHistory.status()).toBe(200);
    const currentHistoryPage = await currentHistory.json();
    expect(currentHistoryPage).toMatchObject({
      record_type: 'observation',
      from: observationRange.fromUtc,
      to: observationRange.toUtc,
      retention: policy,
    });
    expect(currentHistoryPage.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            values: expect.objectContaining({ temperature: 22 }),
          }),
        }),
      ]),
    );
    await expect(
      history.getByText('22 degC', { exact: true }).first(),
    ).toBeVisible();
    await page.route('**/entities/*/history?*', (route) => route.abort());
    await history
      .getByRole('button', { name: '刷新历史', exact: true })
      .click();
    await expect(
      history.getByRole('button', { name: '重试历史查询' }),
    ).toBeVisible();
    await page.unroute('**/entities/*/history?*');
    await history.getByRole('button', { name: '重试历史查询' }).click();
    await expect(
      history.getByRole('button', { name: '重试历史查询' }),
    ).toHaveCount(0);
    await inspector.getByRole('tab', { name: '操作', exact: true }).click();
    await inspector
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    const secondResponse = await agent.post(
      `/api/v1/lab/labs/${lab}/entities`,
      {
        data: {
          name: 'Active retained centrifuge',
          definition_id: 'centrifuge',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
          representation_id: null,
        },
      },
    );
    expect(secondResponse.status()).toBe(201);
    const second = await secondResponse.json();
    const secondPath = `/api/v1/lab/labs/${lab}/entities/${second.id}`;
    expect((await agent.post(`${secondPath}/program/start`)).status()).toBe(
      201,
    );
    const active = await agent.post(`${secondPath}/actions`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: {
        capability: 'centrifuge.start',
        parameters: { rpm: 500, temperature: 22, duration_seconds: 3600 },
      },
    });
    expect(active.status()).toBe(202);
    const activeCommand = await active.json();
    await inspector.getByRole('tab', { name: '记录', exact: true }).click();
    if (!desktopMigration)
      await page.setViewportSize({ width: 320, height: 850 });
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    const narrow = page.getByRole('region', { name: 'Run history' });
    await narrow.scrollIntoViewIfNeeded();
    await expect(
      narrow.getByRole('button', { name: 'Query history' }),
    ).toBeVisible();
    await narrow
      .getByRole('button', { name: 'Query history' })
      .scrollIntoViewIfNeeded();
    await expect(
      narrow.getByRole('button', { name: 'Query history' }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await canvasPixels(
      page,
      `test-results/lab-foundation/t08-history-${desktopMigration ? 'desktop' : 'mobile'}-canvas.png`,
    );
    await page.screenshot({
      path: `test-results/lab-foundation/t08-history-${desktopMigration ? 'desktop' : 'mobile'}-dark-en.png`,
      fullPage: true,
    });
    await expect
      .poll(() => Date.now() - Date.parse(completed.task.ended_at), {
        timeout: 30000,
      })
      .toBeGreaterThan(20000);
    const before = await get(path);
    expect(before.observation.properties.temperature.freshness).toBe('stale');
    const cleanup = await agent.post(`/api/v1/lab/labs/${lab}/history/cleanup`);
    expect(cleanup.status()).toBe(200);
    const deleted = await cleanup.json();
    expect(deleted.tasks).toBeGreaterThan(0);
    expect(deleted.observations).toBeGreaterThan(0);
    const retained = await get(path);
    expect(retained.task).toBeNull();
    expect(retained.task_result).toBeNull();
    expect(retained.observation).toEqual(before.observation);
    expect(retained.configuration).toEqual(before.configuration);
    for (const suffix of [
      `tasks/${completed.task.id}`,
      `results/${completed.task_result.id}`,
      `commands/${completed.task.command_id}`,
    ])
      expect((await agent.get(`${path}/${suffix}`)).status()).toBe(404);
    expect((await get(secondPath)).task.id).toBe(activeCommand.task_id);
    const expiredRetry = await agent.post(`${path}/actions`, {
      headers: { 'Idempotency-Key': originalCommand.request_key },
      data: {
        capability: originalCommand.capability,
        parameters: originalCommand.parameters,
      },
    });
    expect(expiredRetry.status()).toBe(410);
    expect((await expiredRetry.json()).error.code).toBe('lab.command_expired');
    const conflictingRetry = await agent.post(`${path}/actions`, {
      headers: { 'Idempotency-Key': originalCommand.request_key },
      data: {
        capability: originalCommand.capability,
        parameters: { ...originalCommand.parameters, rpm: 700 },
      },
    });
    expect(conflictingRetry.status()).toBe(409);
    expect((await get(path)).task).toBeNull();
    const gap = await get(query('observation'));
    expect(gap.gap).toBe(true);
    expect(gap.items).toHaveLength(0);
    await narrow.getByRole('button', { name: 'Refresh history' }).click();
    await expect(narrow.getByText('No records within retention')).toBeVisible();
    await expect(
      narrow.getByRole('status', { name: 'History gap' }),
    ).toBeVisible();
    execFileSync('node', ['examples/lab/query-history.mjs', '--cleanup'], {
      env: {
        ...process.env,
        LAB_API_BASE: process.env.E2E_API_URL,
        LAB_API_KEY: credential.secret,
        LAB_ID: lab,
        LAB_ENTITY_ID: entity,
      },
      stdio: 'pipe',
    });
    expect(errors).toEqual([]);
  } finally {
    await agent.dispose();
  }
});
