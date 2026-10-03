import {
  expect,
  test,
  request as playwrightRequest,
  type Page,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test.use({ locale: 'zh-CN' });
async function canvasPixels(page: Page, path?: string) {
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
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    return new Set(
      Array.from(
        { length: Math.floor(pixels.length / 16) },
        (_, index) =>
          `${pixels[index * 16] >> 4}:${pixels[index * 16 + 1] >> 4}:${pixels[index * 16 + 2] >> 4}`,
      ),
    ).size;
  }, png.toString('base64'));
  expect(colors).toBeGreaterThan(20);
  return png;
}
test('centrifuge results survive closed browsers and a real API process restart', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`centrifuge-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('centrifuge-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('Backend centrifuge lab');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '创建', exact: true })
    .click();
  const inspector = page.getByRole('complementary', { name: '对象信息' });
  const paths: string[] = [];
  let lab = '';
  for (const name of ['Centrifuge A', 'Centrifuge B']) {
    await page.getByRole('button', { name: '登记对象', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('定义版本').selectOption('centrifuge@1.0');
    await dialog.getByLabel('名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '登记', exact: true }).click();
    await expect(
      inspector.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    const id = await inspector
      .locator('dt')
      .filter({ hasText: /^Entity$/ })
      .locator('+ dd')
      .innerText();
    lab = await inspector
      .locator('dt')
      .filter({ hasText: /^Lab$/ })
      .locator('+ dd')
      .innerText();
    paths.push(`/api/v1/lab/labs/${lab}/entities/${id}`);
    await inspector
      .getByRole('button', { name: '启动程序', exact: true })
      .click();
    await expect(
      inspector.getByRole('button', { name: '开始离心', exact: true }),
    ).toBeEnabled();
  }
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const credential = await (
    await page.request.post('/api/v1/api-keys', {
      headers: {
        origin: process.env.E2E_WEB_URL!,
        'x-csrf-token': session.csrf_token,
      },
      data: {
        name: 'Centrifuge Agent',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
    })
  ).json();
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${credential.secret}` },
  });
  const get = async (path: string) => await (await agent.get(path)).json();
  try {
    await page
      .getByRole('button', { name: '选择 Centrifuge A', exact: true })
      .click();
    await inspector.getByLabel('目标转速 (rpm)').fill('503');
    await inspector.getByLabel('目标温度 (degC)').fill('22');
    await inspector.getByLabel('任务时长 (s)').fill('12');
    await inspector
      .getByRole('button', { name: '开始离心', exact: true })
      .click();
    await expect
      .poll(async () => (await get(paths[0])).task?.status)
      .toBe('running');
    const first = await get(paths[0]);
    expect(first.task.parameters).toEqual({
      rpm: 503,
      temperature: 22,
      duration_seconds: 12,
    });
    expect((await get(paths[1])).observation.values.speed).toBe(0);
    await expect(
      inspector.getByRole('button', { name: '开始离心', exact: true }),
    ).toBeDisabled();
    await expect(
      inspector.getByRole('button', { name: '停止离心', exact: true }),
    ).toBeEnabled();
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const before = await canvasPixels(page);
    await page.evaluate(async () => {
      for (let frame = 0; frame < 8; frame++)
        await new Promise(requestAnimationFrame);
    });
    const after = await page.locator('canvas').screenshot();
    expect(before.equals(after)).toBe(false);
    await page
      .getByRole('button', { name: '选择 Centrifuge B', exact: true })
      .click();
    await inspector.getByLabel('目标转速 (rpm)').fill('6000');
    await inspector.getByLabel('目标温度 (degC)').fill('22');
    await inspector
      .getByRole('button', { name: '开始离心', exact: true })
      .click();
    await expect
      .poll(async () => (await get(paths[1])).observation.values.speed)
      .toBeGreaterThan(0);
    await inspector
      .getByRole('button', { name: '停止离心', exact: true })
      .click();
    await expect
      .poll(async () => (await get(paths[1])).task_result?.status)
      .toBe('cancelled');
    const cancelled = await get(paths[1]);
    expect(cancelled.observation.values.phase).toBe('idle');
    expect(cancelled.observation.values.speed).toBe(0);
    await page.screenshot({
      path: 'test-results/lab-foundation/t06-centrifuge-desktop.png',
      fullPage: true,
    });
    const state = await page.context().storageState();
    await page.context().close();
    await expect
      .poll(async () => (await get(paths[0])).task_result?.status, {
        timeout: 25000,
      })
      .toBe('completed');
    expect((await get(paths[0])).observation.values.phase).toBe('idle');
    expect((await get(`${paths[0]}/tasks/${first.task.id}`)).status).toBe(
      'completed',
    );
    expect(
      (await get(`${paths[1]}/results/${cancelled.task.result_id}`)).status,
    ).toBe('cancelled');
    const context = await browser.newContext({
      storageState: state,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    const reopened = await context.newPage();
    reopened.setDefaultTimeout(10000);
    reopened.on('pageerror', (error) => errors.push(error.name));
    try {
      await reopened.goto('/lab');
      await reopened
        .getByRole('combobox', { name: '打开 Lab' })
        .selectOption(lab);
      await reopened
        .getByRole('button', { name: '选择 Centrifuge A', exact: true })
        .click();
      const detail = reopened.getByRole('complementary', { name: '对象信息' });
      await expect(
        detail
          .getByRole('region', { name: '本次任务' })
          .getByText('已完成', { exact: true }),
      ).toHaveCount(2);
      const long = await agent.post(`${paths[0]}/actions`, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: {
          capability: 'centrifuge.start',
          parameters: { rpm: 6000, temperature: 4, duration_seconds: 3600 },
        },
      });
      expect(long.status()).toBe(202);
      const accepted = await long.json();
      await expect
        .poll(async () => (await get(paths[0])).observation.values.speed)
        .toBeGreaterThan(0);
      const retained = await get(paths[0]);
      const pidFile = process.env.E2E_API_PID_FILE!;
      const oldPid = Number(readFileSync(pidFile, 'utf8'));
      expect(oldPid).toBeGreaterThan(1);
      process.kill(oldPid, 'SIGKILL');
      await expect
        .poll(() => Number(readFileSync(pidFile, 'utf8')))
        .not.toBe(oldPid);
      await expect
        .poll(
          async () => {
            try {
              return (await get(paths[0])).program_run?.status;
            } catch {
              return 'unavailable';
            }
          },
          { timeout: 15000 },
        )
        .toBe('interrupted');
      const interrupted = await get(paths[0]);
      expect(interrupted.program_run.id).toBe(retained.program_run.id);
      expect(interrupted.task.id).toBe(accepted.task_id);
      expect(interrupted.task.status).toBe('interrupted');
      expect(interrupted.task.parameters).toEqual({
        rpm: 6000,
        temperature: 4,
        duration_seconds: 3600,
      });
      expect(interrupted.task_result.id).toBe(retained.task_result.id);
      expect(interrupted.task_result.status).toBe('interrupted');
      expect(interrupted.observation.values).toEqual(
        retained.observation.values,
      );
      expect(interrupted.observation.received_at).toBe(
        retained.observation.received_at,
      );
      await expect(
        detail.getByRole('button', { name: '启动程序', exact: true }),
      ).toBeEnabled({ timeout: 20000 });
      await expect(
        detail
          .getByRole('region', { name: '本次任务' })
          .getByText('已中断', { exact: true }),
      ).toHaveCount(2);
      await detail
        .getByRole('button', { name: '启动程序', exact: true })
        .click();
      await expect
        .poll(async () => (await get(paths[0])).program_run.id)
        .not.toBe(retained.program_run.id);
      await expect
        .poll(async () => (await get(paths[0])).observation.values.speed)
        .toBe(0);
      expect(
        (await get(`${paths[0]}/runs/${retained.program_run.id}`)).status,
      ).toBe('interrupted');
      expect((await get(`${paths[0]}/tasks/${accepted.task_id}`)).status).toBe(
        'interrupted',
      );
      expect(
        (await get(`${paths[0]}/results/${retained.task_result.id}`)).status,
      ).toBe('interrupted');
      expect((await get(`${paths[0]}/tasks/${first.task.id}`)).status).toBe(
        'completed',
      );
      await reopened.setViewportSize({ width: 320, height: 850 });
      await reopened
        .getByRole('button', { name: 'English', exact: true })
        .click();
      await reopened.getByRole('button', { name: 'Dark', exact: true }).click();
      await canvasPixels(
        reopened,
        'test-results/lab-foundation/t06-centrifuge-mobile-canvas.png',
      );
      const controls = reopened
        .getByRole('complementary', { name: 'Object info' })
        .getByRole('region', { name: 'Centrifuge task' });
      await controls.scrollIntoViewIfNeeded();
      await expect(
        controls.getByRole('button', { name: 'Start centrifuge' }),
      ).toBeEnabled();
      expect(
        await reopened.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await reopened.screenshot({
        path: 'test-results/lab-foundation/t06-centrifuge-mobile-dark-en.png',
        fullPage: true,
      });
      execFileSync('node', ['examples/lab/run-centrifuges.mjs'], {
        env: {
          ...process.env,
          LAB_API_BASE: process.env.E2E_API_URL,
          LAB_API_KEY: credential.secret,
          LAB_ID: lab,
        },
        stdio: 'pipe',
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  } finally {
    await agent.dispose();
  }
});
