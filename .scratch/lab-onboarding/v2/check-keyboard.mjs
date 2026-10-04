import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5194/prototype/lab-onboarding');
  await page.locator('.driver-popover').waitFor();
  await page.keyboard.press('Escape');
  await expect(page.locator('.driver-popover')).toHaveCount(0);
  await page.locator('[data-tour="help"]').click();
  await page.locator('[data-tour="create-lab"]').focus();
  await page.keyboard.press('Enter');
  await page.locator('#lab-name').fill('键盘创建实验室');
  await page.keyboard.press('Enter');
  await page.locator('[data-tour="register"]').click();
  await page
    .locator('[data-tour="register-form"] button[type="submit"]')
    .click();
  await page.locator('[data-tour="light-row"]').click();
  await page.locator('[data-tour="edit-mode"]').click();
  await page.locator('#placement-X').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('-3.2');
  await expect(page.locator('#placement-X')).toHaveValue('-3.2');
  await page.locator('#rotation').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('-15');
  await expect(page.locator('#rotation')).toHaveValue('-15');
  await page.locator('.driver-popover-next-btn').click();
  await page.locator('[data-tour="save"]').click();
  await expect(page.locator('.driver-popover')).toHaveAttribute(
    'data-tour-target',
    'runtime-mode',
  );
  const stored = await page.evaluate(() => {
    const world = JSON.parse(
      localStorage.getItem('PROTOTYPE-lab-onboarding-v2'),
    );
    const tour = JSON.parse(
      localStorage.getItem('PROTOTYPE-lab-onboarding-v2-tour'),
    );
    return world.labs
      .find((lab) => lab.id === world.activeId)
      .entities.find((entity) => entity.id === tour.entityId);
  });
  assert.equal(stored.position[0], -3.2);
  assert.equal(stored.rotation, -15);
  assert.deepEqual(errors, []);
  await writeFile(
    new URL('./evidence/keyboard.json', import.meta.url),
    JSON.stringify(
      {
        checks: [
          'Escape skips',
          'Help resumes',
          'Enter opens and submits the normal form',
          'Negative decimal coordinate can be typed one character at a time',
          'Negative rotation can be typed one character at a time',
          'Saved placement matches the keyboard input',
        ],
        saved: { position: stored.position, rotation: stored.rotation },
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: 6, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
