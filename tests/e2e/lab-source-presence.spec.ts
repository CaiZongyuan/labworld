import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreHttp } from '../support/core-http';
import type {
  LabSourceConfiguration,
  LabSourceConnection,
} from '../../packages/contracts/src/generated/types.gen';

test.use({
  locale: 'zh-CN',
  viewport: { width: 1440, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
test('source presence: the normal desktop form generates a private config, shows initialization and online status, then revokes without a scene', async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`source-browser-${Date.now()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('source-browser-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/lab$/);
  await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
  const labDialog = page.getByRole('dialog');
  await labDialog.getByLabel('名称', { exact: true }).fill('来源先于场景');
  await labDialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '来源先于场景', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^来源/ }).click();
  const dialog = page.getByRole('dialog', { name: '来源', exact: true });
  await dialog.getByLabel('来源名称', { exact: true }).fill('原 Newton 程序');
  const configured = page.waitForResponse(
    (response) =>
      response.url().endsWith('/configuration') &&
      response.request().method() === 'POST',
  );
  await dialog
    .getByRole('button', { name: '创建来源接入配置', exact: true })
    .click();
  const response = await configured;
  expect(response.status()).toBe(201);
  const config = (await response.json()) as LabSourceConfiguration;
  expect(config.credential.length).toBe(43);
  await dialog.getByRole('button', { name: '复制配置', exact: true }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: '已复制配置' }),
  ).toBeVisible();
  // Only record a boolean; test reporters never print a credential comparison.
  const copied = await page.evaluate(
    async (expected) => (await navigator.clipboard.readText()) === expected,
    JSON.stringify(config, null, 2),
  );
  expect(copied).toBe(true);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const path = `/api/v1/lab/labs/${config.lab_id}/sources/${config.source_id}`;
  const producer = new CoreHttp(config.server_url, {
    authorization: `Bearer ${config.credential}`,
  });
  let connection: LabSourceConnection | undefined;
  try {
    connection = await producer.json<LabSourceConnection>(
      'POST',
      path + '/connections',
      {
        machine_id: config.machine_id,
        source_run_id: randomUUID(),
        phase: 'initializing',
      },
      201,
    );
    await page.getByRole('button', { name: /^来源/ }).click();
    await expect(dialog.getByText('来源已连接', { exact: true })).toBeVisible();
    await expect(
      dialog.getByText('适配器正在初始化', { exact: true }),
    ).toBeVisible();
    expect(await dialog.getByLabel('来源接入配置').count()).toBe(0);
    await producer.json('POST', path + '/heartbeat', {
      machine_id: config.machine_id,
      connection_id: connection.connection_id,
      epoch: connection.epoch,
      phase: 'ready',
    });
    await expect(
      dialog.getByText('适配器已就绪', { exact: true }),
    ).toBeVisible();
    if (process.env.LAB_NODE_EVIDENCE)
      await page.screenshot({
        path: join(process.env.LAB_NODE_EVIDENCE, 'source-connected.png'),
      });
    await dialog
      .getByRole('button', { name: '撤销来源访问', exact: true })
      .click();
    await expect(dialog.getByText('访问已撤销', { exact: true })).toBeVisible();
    await expect(dialog.getByText('来源失联', { exact: true })).toBeVisible();
    await producer.error(
      'POST',
      path + '/heartbeat',
      {
        machine_id: config.machine_id,
        connection_id: connection.connection_id,
        epoch: connection.epoch,
        phase: 'ready',
      },
      403,
      'identity.machine_unauthorized',
    );
    const world = await page.evaluate(
      async (lab) => (await fetch(`/api/v1/lab/labs/${lab}/world`)).json(),
      config.lab_id,
    );
    expect(world.entities.length).toBe(0);
    expect(world.nodes.length).toBe(0);
    if (process.env.LAB_NODE_EVIDENCE)
      writeFileSync(
        join(process.env.LAB_NODE_EVIDENCE, 'source-presence-receipt.json'),
        JSON.stringify({
          stages: [
            'normal-config',
            'clipboard-cleared',
            'initializing',
            'connected',
            'revoked',
          ],
          sourceIdentityStable: true,
          noScene: world.nodes.length === 0,
          noDeviceFacts: world.entities.length === 0,
          pageErrors: errors,
        }),
      );
    expect(errors).toEqual([]);
  } finally {
    if (connection)
      await producer
        .response('POST', path + '/disconnect', {
          machine_id: config.machine_id,
          connection_id: connection.connection_id,
          epoch: connection.epoch,
        })
        .then((result) => result.arrayBuffer());
  }
});
