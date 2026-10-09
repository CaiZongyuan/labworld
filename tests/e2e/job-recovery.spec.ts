import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { waitFor } from '../../scripts/lib/process.mjs';

// The device language follows the browser in the product, so journeys that
// assert Chinese pin the locale explicitly instead of relying on the
// runner default (see password-reset.spec.ts).
test.use({ locale: 'zh-CN' });

test('a crashed Worker recovers its export and an administrator retries a later storage failure', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const container = process.env.E2E_STORAGE_CONTAINER;
  const pidFile = process.env.E2E_WORKER_PID_FILE;
  const originalPid = pidFile ? Number(readFileSync(pidFile, 'utf8')) : 0;
  if (!container || !Number.isInteger(originalPid) || originalPid <= 1)
    throw new Error('Use the isolated E2E runner');
  let paused = false;
  const storage = (pause: boolean) => {
    execFileSync('docker', [pause ? 'pause' : 'unpause', container], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    paused = pause;
  };
  try {
    await page.goto('/register');
    await page
      .getByLabel('邮箱', { exact: true })
      .fill('recovery-writer@example.com');
    await page
      .getByLabel('密码', { exact: true })
      .fill('browser-test-password');
    await page.getByRole('button', { name: '创建账号' }).click();
    await page.getByRole('link', { name: '我的文档', exact: true }).click();
    await page.getByRole('button', { name: '新建文档' }).click();
    await page.getByLabel('标题', { exact: true }).fill('任务恢复');
    await page.getByLabel('Markdown 正文').fill('重启后继续导出。');
    await page.getByRole('button', { name: '保存文档' }).click();
    await expect(page.getByLabel('选择附件')).toBeEnabled();
    await page.getByLabel('选择附件').setInputFiles({
      name: 'recovery.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('recovery bytes'),
    });
    await page.getByRole('button', { name: '上传附件' }).click();
    await expect(
      page.getByRole('button', { name: '下载 recovery.txt' }),
    ).toBeVisible();
    storage(true);
    await page.getByRole('button', { name: '导出当前文档' }).click();
    await expect(page.getByText('正在生成', { exact: true })).toBeVisible();
    // The real handler is blocked on its snapshot input; kill only this runner's Worker.
    process.kill(originalPid, 'SIGKILL');
    storage(false);
    await waitFor(`http://${process.env.WORKER_BIND}/health/ready`);
    expect(Number(readFileSync(pidFile!, 'utf8'))).not.toBe(originalPid);
    await expect(page.getByRole('button', { name: '下载 ZIP' })).toBeVisible({
      timeout: 25_000,
    });

    storage(true);
    await page.getByRole('button', { name: '导出当前文档' }).click();
    await expect(page.getByText('导出失败', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    storage(false);
    const adminContext = await browser.newContext({ locale: 'zh-CN' });
    try {
      const admin = await adminContext.newPage();
      await admin.goto(`${process.env.E2E_WEB_URL}/login`);
      await admin
        .getByLabel('邮箱', { exact: true })
        .fill(process.env.E2E_OWNER_EMAIL!);
      await admin
        .getByLabel('密码', { exact: true })
        .fill(process.env.E2E_OWNER_PASSWORD!);
      await admin.getByRole('button', { name: '登录', exact: true }).click();
      await admin.getByRole('link', { name: '后台任务' }).click();
      await admin
        .getByRole('button', { name: /查看任务 / })
        .first()
        .click();
      await expect(
        admin.getByText('当前第 1 批 · 已尝试 2 / 2 次'),
      ).toBeVisible();
      const jobUrl = admin.url();
      await admin.getByRole('button', { name: '重试失败任务' }).click();
      await expect(
        admin.getByText('当前第 2 批 · 已尝试 1 / 2 次'),
      ).toBeVisible({ timeout: 20_000 });
      await expect(admin.getByText('已完成', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      expect(admin.url()).toBe(jobUrl);
      await expect(admin.getByText('第 1 批', { exact: true })).toBeVisible();
      await expect(admin.getByText('第 2 批', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '刷新导出状态' }).click();
      await expect(page.getByRole('button', { name: '下载 ZIP' })).toHaveCount(
        2,
      );
    } finally {
      await adminContext.close();
    }
  } finally {
    if (paused) storage(false);
    // The runner retains the replacement for the rest of this suite.
    await waitFor(`http://${process.env.WORKER_BIND}/health/ready`);
  }
});
