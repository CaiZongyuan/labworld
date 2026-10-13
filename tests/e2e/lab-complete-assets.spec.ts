import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CurrentSession,
  FileInfo,
  UploadCapability,
} from '../../packages/contracts/src/generated/types.gen';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
test('complete asset descriptions import through the real library and expose fixed information and retained resources', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`asset-version-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('asset-version-browser-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/lab$/);
  const api = process.env.E2E_API_URL!;
  const origin = new URL(page.url()).origin;
  const session = (await (
    await page.request.get(api + '/api/v1/auth/session')
  ).json()) as CurrentSession;
  const bytes = Buffer.from('%PDF-1.4\nVersioned centrifuge manual\n');
  const start = await page.request.post(
    api + '/api/v1/lab/asset-resource-uploads',
    {
      headers: { 'x-csrf-token': session.csrf_token, origin },
      data: {
        file_name: 'manual.pdf',
        content_type: 'application/pdf',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    },
  );
  expect(start.status()).toBe(201);
  const upload = (await start.json()) as UploadCapability;
  const put = await page.request.put(upload.upload!.url, {
    headers: upload.upload!.headers,
    data: bytes,
  });
  expect(put.status()).toBe(204);
  const complete = await page.request.post(
    api + `/api/v1/lab/asset-resource-uploads/${upload.upload_id}/complete`,
    { headers: { 'x-csrf-token': session.csrf_token, origin } },
  );
  expect(complete.status()).toBe(200);
  const file = (await complete.json()) as FileInfo;
  const description = {
    schema_version: 1,
    asset_id: 'browser/centrifuge-c',
    version: '1.0.0',
    name: '离心机 C',
    name_en: 'Centrifuge C',
    category: 'instrument',
    manufacturer: 'Reference Instruments',
    model: 'C-15',
    source: 'Public fixture',
    license: 'CC0',
    specifications: { maximum_speed: { value: 15000, unit: 'rpm' } },
    configuration_schema: {
      type: 'object',
      properties: { temperature: { type: 'number', unit: 'degC' } },
    },
    state_schema: {
      type: 'object',
      properties: {
        speed: { type: 'number', unit: 'rpm' },
        temperature: { type: 'number', unit: 'degC' },
      },
    },
    capabilities: [
      {
        id: 'centrifuge.start',
        version: '1.0',
        parameters: {
          type: 'object',
          properties: { rpm: { type: 'integer', maximum: 15000 } },
        },
        result: { type: 'boolean' },
      },
    ],
    resources: [
      {
        key: 'manual',
        format: 'pdf',
        file_id: file.id,
        sha256: file.sha256,
        size: file.size,
      },
    ],
    representations: [
      {
        key: 'manual',
        purpose: 'documentation',
        resource_keys: ['manual'],
        components: [],
      },
    ],
  };
  await page.goto('/assets');
  await expect(
    page.getByRole('button', { name: '导入资产描述', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel('资产描述 JSON 文件', { exact: true }).setInputFiles({
    name: 'centrifuge.asset.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(description)),
  });
  const info = page.getByRole('button', {
    name: '查看资产信息 离心机 C v1.0.0',
    exact: true,
  });
  await expect(info).toBeVisible();
  await info.click();
  const dialog = page.getByRole('dialog', { name: '离心机 C' });
  await expect(dialog).toContainText('Reference Instruments');
  await expect(dialog).toContainText('C-15');
  await expect(dialog).toContainText('配置字段');
  await expect(dialog).toContainText('状态字段');
  await expect(dialog).toContainText('rpm');
  await expect(dialog).toContainText('degC');
  await expect(dialog).toContainText('centrifuge.start');
  await expect(
    dialog.getByRole('button', { name: /启动|保存|编辑/ }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: '下载 manual.pdf', exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await dialog
    .getByRole('button', { name: '下载 manual.pdf', exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe('manual.pdf');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expect(info).toBeVisible();
  await page.getByLabel('资产描述 JSON 文件', { exact: true }).setInputFiles({
    name: 'conflict.asset.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...description, model: 'C-20' })),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await info.click();
  await expect(dialog).toContainText('C-15');
  await expect(dialog).not.toContainText('C-20');
  await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
  if (process.env.LAB_NODE_EVIDENCE) {
    await page.screenshot({
      path: join(
        process.env.LAB_NODE_EVIDENCE,
        'complete-asset-information.png',
      ),
    });
    writeFileSync(
      join(process.env.LAB_NODE_EVIDENCE, 'complete-asset-journey.json'),
      JSON.stringify(
        {
          importedThroughLibrary: true,
          immutableConflictPreservedOldInformation: true,
          download: 'manual.pdf',
          viewport: { width: 1440, height: 1000 },
          errors,
        },
        null,
        2,
      ),
    );
  }
});
