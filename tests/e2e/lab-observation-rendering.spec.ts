import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { showEntityOperations, showObjectDirectory } from './lab-desktop';

test.use({ locale: 'zh-CN' });

async function changedPixels(page: Page, before: Buffer, after: Buffer) {
  return page.evaluate(
    async (encoded) => {
      const frames = await Promise.all(
        encoded.map(async (frame) => {
          const image = new Image();
          image.src = `data:image/png;base64,${frame}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        }),
      );
      let changed = 0;
      for (let i = 0; i < frames[0].length; i += 4)
        if (
          Math.abs(frames[0][i] - frames[1][i]) +
            Math.abs(frames[0][i + 1] - frames[1][i + 1]) +
            Math.abs(frames[0][i + 2] - frames[1][i + 2]) >
          30
        )
          changed++;
      return changed;
    },
    [before.toString('base64'), after.toString('base64')],
  );
}

test('3D readings retain confirmed stopped facts and all rotors stop claiming current motion on disconnect', async ({
  page,
  context,
}, info) => {
  test.setTimeout(60000);
  const facts: Record<string, unknown> = {};
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const delivery = { held: false, release: [] as (() => void)[] };
    Object.assign(window, { worldDelivery: delivery });
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (/\/world$/.test(url) && delivery.held)
        return new Promise<Response>((resolve) =>
          delivery.release.push(() => resolve(response)),
        );
      if (!/\/world\/subscribe$/.test(url) || !response.body) return response;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffered = '';
      // Delay actual HTTP World events while keeping real runtime/heartbeat events live.
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, target) {
            buffered += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buffered.indexOf('\n\n')) >= 0) {
              const frame = buffered.slice(0, end + 2);
              buffered = buffered.slice(end + 2);
              const send = () => target.enqueue(encoder.encode(frame));
              if (
                delivery.held &&
                /"type"\s*:\s*"(?:snapshot|update)"/.test(frame)
              )
                delivery.release.push(send);
              else send();
            }
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    };
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/register');
    await page
      .getByLabel('邮箱', { exact: true })
      .fill(`rendering-${Date.now()}@example.test`);
    await page
      .getByLabel('密码', { exact: true })
      .fill('rendering-browser-password');
    await page.getByRole('button', { name: '创建账号' }).click();
    await expect(page).toHaveURL(/\/lab$/);
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('名称', { exact: true })
      .fill('Rendering facts');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '创建', exact: true })
      .click();
    const inspector = page.getByRole('complementary', { name: '对象信息' });
    for (const name of ['Rotor A', 'Rotor B']) {
      await page.getByRole('button', { name: '登记对象', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('定义版本').selectOption('centrifuge@1.0');
      await dialog.getByLabel('名称', { exact: true }).fill(name);
      await dialog.getByRole('button', { name: '登记', exact: true }).click();
      await showEntityOperations(page);
      await inspector
        .getByRole('button', { name: '启动程序', exact: true })
        .click();
      await expect(inspector.getByLabel('关键观测有效性')).toHaveText(
        '当前关键观测有效',
      );
    }
    await showObjectDirectory(page);
    await page
      .getByRole('button', { name: '选择 Rotor A', exact: true })
      .click();
    await showEntityOperations(page);
    await expect(page.getByRole('img', { name: /^Rotor A:/ })).toContainText(
      '空闲',
    );
    const canvas = page.locator('.world-viewport canvas');
    await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
    await expect
      .poll(async () =>
        changedPixels(
          page,
          await canvas.screenshot(),
          await canvas.screenshot(),
        ),
      )
      .toBe(0);
    await page.evaluate(() => {
      (
        window as unknown as { worldDelivery: { held: boolean } }
      ).worldDelivery.held = true;
    });
    const stopped = page.waitForResponse(
      (response) =>
        response.url().endsWith('/program/stop') &&
        response.request().method() === 'POST',
    );
    await inspector
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    const response = await stopped;
    expect(response.status()).toBe(200);
    const stoppedRun = await response.json();
    facts.stoppedRun = { id: stoppedRun.id, status: stoppedRun.status };
    await expect(
      inspector.getByText('来源已停止，最后观测保留。'),
    ).toBeVisible();
    await expect
      .soft(page.getByRole('img', { name: /^Rotor A:/ }))
      .toContainText('最后报告值');
    facts.sceneAfterConfirmedStop = await page
      .getByRole('img', { name: /^Rotor A:/ })
      .innerText();
    await page.evaluate(() => {
      const delivery = (
        window as unknown as {
          worldDelivery: { held: boolean; release: (() => void)[] };
        }
      ).worldDelivery;
      delivery.held = false;
      delivery.release.splice(0).forEach((release) => release());
    });
    for (const name of ['Rotor A', 'Rotor B']) {
      await showObjectDirectory(page);
      await page
        .getByRole('button', { name: `选择 ${name}`, exact: true })
        .click();
      await showEntityOperations(page);
      const startSource = inspector.getByRole('button', {
        name: '启动程序',
        exact: true,
      });
      if (await startSource.count()) await startSource.click();
      await expect(inspector.getByLabel('关键观测有效性')).toHaveText(
        '当前关键观测有效',
      );
      await inspector.getByLabel('目标转速 (rpm)').fill('701');
      await inspector.getByLabel('目标温度 (degC)').fill('22');
      await inspector.getByLabel('任务时长 (s)').fill('120');
      await inspector
        .getByRole('button', { name: '开始离心', exact: true })
        .click();
      await expect(
        inspector
          .getByRole('region', { name: '观测转速' })
          .locator('.observation-value'),
      ).toHaveText('701 rpm');
    }
    // Unselect both: connection validity applies to every rendered Entity.
    await page
      .locator('.world-viewport canvas')
      .click({ position: { x: 5, y: 5 } });
    facts.runningPixels = await changedPixels(
      page,
      await canvas.screenshot(),
      await canvas.screenshot(),
    );
    expect(facts.runningPixels).toBeGreaterThan(30);
    await context.setOffline(true);
    await expect(page.getByText('连接中断', { exact: true })).toBeVisible();
    const before = await canvas.screenshot({
      path: info.outputPath('offline-before.png'),
    });
    const after = await canvas.screenshot({
      path: info.outputPath('offline-after.png'),
    });
    facts.offlinePixels = await changedPixels(page, before, after);
    expect.soft(facts.offlinePixels).toBe(0);
  } finally {
    mkdirSync(info.outputDir, { recursive: true });
    writeFileSync(
      join(info.outputDir, 'rendering-facts.json'),
      JSON.stringify(facts, null, 2),
    );
    await context.setOffline(false);
  }
});
