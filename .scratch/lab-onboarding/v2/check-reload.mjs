// Regression: idle pages must not receive reload/update messages from their own logs.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const checks = [];
try {
  for (const width of [1440, 390]) {
    const reloads = [];
    const navigations = [];
    const errors = [];
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString());
          if (message.type === 'full-reload' || message.type === 'update')
            reloads.push(message);
        } catch {}
      }),
    );
    await page.goto('http://127.0.0.1:5194/prototype/lab-onboarding');
    await page.locator('canvas').waitFor();
    await page.locator('[data-tour="create-lab"]').click();
    await page.getByLabel('实验室名称').fill('不会被重载清空的名称');
    const marker = `Reload regression console output ${process.pid} ${width}`;
    await page.evaluate((message) => console.warn(message), marker);
    await page.waitForTimeout(10000);
    const result = { width, navigations, reloads, errors };
    console.log(JSON.stringify(result, null, 2));
    assert.equal(
      reloads.length,
      0,
      'Idle preview received unsolicited reload/update messages',
    );
    assert.equal(
      navigations.length,
      1,
      'Idle preview navigated more than once',
    );
    assert.deepEqual(errors, []);
    await expect(page.getByLabel('实验室名称')).toHaveValue(
      '不会被重载清空的名称',
    );
    assert.ok(
      (
        await readFile(new URL('./dev-server.log', import.meta.url), 'utf8')
      ).includes(marker),
      'The regression must exercise actual forwarded console writes',
    );
    checks.push(result);
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(
  new URL('./evidence/reload-check.json', import.meta.url),
  JSON.stringify({ checks }, null, 2),
);
