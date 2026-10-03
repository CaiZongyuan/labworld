import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { type LabWorld } from '../../packages/sdk/src/index';

export const evidence = '.scratch/foundation-v1/application';
mkdirSync(evidence, { recursive: true });
export async function retainFailure({ page }: { page: Page }, info: TestInfo) {
  if (info.status === info.expectedStatus) return;
  writeFileSync(
    `${evidence}/failure.json`,
    JSON.stringify({
      status: info.status,
      locations: info.errors.map(
        (error) =>
          error.stack?.match(
            /lab-(?:foundation|reference-load)\.spec\.ts:\d+:\d+/g,
          ) ?? [],
      ),
    }),
  );
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true });
}

export async function member(page: Page) {
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`foundation-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('foundation-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  expect(session.user.role).toBe('member');
  const headers = {
    origin: process.env.E2E_WEB_URL!,
    'x-csrf-token': session.csrf_token,
  };
  const credential = await (
    await page.request.post('/api/v1/api-keys', {
      headers,
      data: {
        name: 'Foundation Agent',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
    })
  ).json();
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${credential.secret}` },
  });
  return { agent, secret: credential.secret, headers };
}
export async function world(
  agent: APIRequestContext,
  lab: string,
): Promise<LabWorld> {
  const response = await agent.get(`/api/v1/lab/labs/${lab}/world`);
  expect(response.status()).toBe(200);
  return response.json();
}
export function chapter(
  name: string,
  env: Record<string, string>,
  args: string[] = [],
) {
  return JSON.parse(
    execFileSync(process.execPath, [`examples/lab/${name}.mjs`, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 60000,
    }),
  );
}
export async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
  const png = await page
    .locator('canvas')
    .screenshot({ path: `${evidence}/${name}-canvas.png` });
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
  return colors;
}
