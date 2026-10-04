import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(
  new URL('../../../package.json', import.meta.url),
);
const { chromium } = require('@playwright/test');
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:5196/prototype/lab-operations');
await page.getByRole('heading', { name: '运行总览', exact: true }).waitFor();
await page.screenshot({
  path: new URL('evidence/overview-desktop.png', import.meta.url).pathname,
  fullPage: true,
});
await page
  .getByRole('button', { name: '查看温度传感器 B', exact: true })
  .click();
await page.screenshot({
  path: new URL('evidence/detail-desktop.png', import.meta.url).pathname,
});
await page.keyboard.press('Escape');
await page
  .getByRole('navigation', { name: '实验室导航', exact: true })
  .getByRole('button', { name: '空间', exact: true })
  .click();
await page.locator('.space-canvas > canvas').waitFor();
await page.waitForTimeout(1000);
await page.screenshot({
  path: new URL('evidence/space-desktop.png', import.meta.url).pathname,
  fullPage: true,
});
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: new URL('evidence/space-mobile.png', import.meta.url).pathname,
  fullPage: true,
});
await page
  .getByRole('navigation', { name: '移动端视图', exact: true })
  .getByRole('button', { name: '运行总览', exact: true })
  .click();
await page.screenshot({
  path: new URL('evidence/overview-mobile.png', import.meta.url).pathname,
  fullPage: true,
});
await writeFile(
  new URL('evidence/initial-inspection.json', import.meta.url),
  JSON.stringify(
    {
      errors,
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ errors }));
await browser.close();
