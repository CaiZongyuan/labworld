import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  emitOpenUrl,
  emitSecondInstance,
  launchApp,
  requireSmokeEnv,
  signIn,
  storedPreferences,
} from './helpers';

/**
 * Electron shell smoke (template core): real shell, real API, real PostgreSQL
 * and the shared views loaded from the same-origin web entry. Knowledge
 * browsing in the shell is covered separately in knowledge-shell.spec.ts;
 * business role matrices stay in backend and shared view tests.
 */

test.describe.configure({ mode: 'serial' });

test('shell loads shared views, signs in and out, and constrains navigation', async () => {
  test.setTimeout(180_000);
  const { app, window, cleanup } = await launchApp();
  const appOrigin = new URL(requireSmokeEnv('E2E_WEB_URL')).origin;

  try {
    // The preload bridge is the only shell API in the page and holds no secrets.
    const info = await window.evaluate(() =>
      (
        window as unknown as {
          labosThreejsDesktop?: {
            getInfo(): Promise<{ version: string; platform: string }>;
          };
        }
      ).labosThreejsDesktop?.getInfo(),
    );
    expect(info?.platform).toBe(process.platform);

    await signIn(window);

    // The system-browser handoff is captured from here on: the shell's
    // behavior is observable without CI ever spawning a real browser.
    const handedOff = () =>
      app.evaluate(
        () => (globalThis as { __smokeExternal?: string[] }).__smokeExternal,
      );
    await app.evaluate(({ shell }) => {
      const captured = [] as string[];
      (globalThis as { __smokeExternal?: string[] }).__smokeExternal = captured;
      (shell as { openExternal: unknown }).openExternal = (url: string) => {
        captured.push(String(url));
        return Promise.resolve();
      };
    });

    // Controlled download entry: an app-page download lands in the shell
    // downloads directory with its suggested name intact.
    const downloadsDir = requireSmokeEnv('LABOS_THREEJS_DESKTOP_DOWNLOADS_DIR');
    const downloadName = '壳级下载验证.txt';
    await window.evaluate((name) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(
        new Blob(['desktop-shell-download'], {
          type: 'application/octet-stream',
        }),
      );
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    }, downloadName);
    await expect
      .poll(() =>
        existsSync(downloadsDir) ? readdirSync(downloadsDir) : ([] as string[]),
      )
      .toContain(downloadName);
    expect(readFileSync(join(downloadsDir, downloadName), 'utf8')).toBe(
      'desktop-shell-download',
    );

    // The same controlled entry refuses downloads started by pages that are
    // not on the app origin: nothing is written for them.
    const foreignName = '跨源下载应被拒绝.txt';
    await window.goto('about:blank');
    await window.evaluate((name) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(
        new Blob(['must-not-save'], { type: 'application/octet-stream' }),
      );
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    }, foreignName);
    await window.waitForTimeout(1_500);
    expect(readdirSync(downloadsDir)).not.toContain(foreignName);
    await window.goto(`${appOrigin}/`);

    // In-page navigation away from the app origin is refused: the window
    // stays, and the target is handed to the system browser instead.
    await window.evaluate(() => {
      globalThis.location.href = 'https://blocked.example/away';
    });
    expect(new URL(window.url()).origin).toBe(appOrigin);
    // The handoff happens asynchronously in the shell's main process, so
    // poll for the capture instead of reading it once.
    await expect
      .poll(handedOff, { timeout: 5_000 })
      .toEqual(['https://blocked.example/away']);
    // The refused navigation never commits, which leaves Playwright's frame
    // tracker waiting on it; reload the app entry before further locator
    // work. The persisted session must survive that reload untouched.
    await window.reload();
    await expect(
      window.getByRole('button', { name: '退出登录' }),
    ).toBeVisible();

    // Popups never open inside the shell; http(s) targets go to the system
    // browser through the shell's controlled openExternal path.
    await window.evaluate(() => {
      globalThis.open('https://portal.example/external', '_blank');
    });
    await expect
      .poll(handedOff, { timeout: 5_000 })
      .toEqual([
        'https://blocked.example/away',
        'https://portal.example/external',
      ]);
    expect(new URL(window.url()).origin).toBe(appOrigin);

    // Out-of-scheme targets are dropped before the system-browser handoff
    // and never move the window.
    await window.evaluate(() => {
      globalThis.location.href = 'chrome://version';
    });
    await window.waitForTimeout(500);
    expect(await handedOff()).toEqual([
      'https://blocked.example/away',
      'https://portal.example/external',
    ]);
    expect(new URL(window.url()).origin).toBe(appOrigin);

    // Deep links navigate within the app only for in-app targets.
    await emitOpenUrl(app, 'labos-threejs://open/notifications');
    await window.waitForURL(/\/notifications$/);
    await expect(window.getByRole('heading', { name: '通知' })).toBeVisible();
    await emitSecondInstance(app, 'labos-threejs://open/notifications');
    expect(new URL(window.url()).pathname).toBe('/notifications');

    const beforeInvalid = window.url();
    await emitOpenUrl(app, 'labos-threejs://close/notifications');
    await emitOpenUrl(app, 'labos-threejs://open//evil.example');
    await emitSecondInstance(app, 'https://evil.example/replace');
    expect(window.url()).toBe(beforeInvalid);
    expect(new URL(window.url()).origin).toBe(appOrigin);

    // Logout works through the same shared home view as in a browser.
    await window.goto(`${appOrigin}/`);
    await window.getByRole('button', { name: '退出登录' }).click();
    await expect(
      window.getByRole('heading', { name: '欢迎使用企业空间' }),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});

test('shell shows a recoverable error state when the app cannot load', async () => {
  // The aborted reload renders the pinned language on the error page, so
  // the launch waits for the mirror to land first.
  const { window, cleanup } = await launchApp({ awaitMirror: true });
  const appOrigin = new URL(requireSmokeEnv('E2E_WEB_URL')).origin;

  try {
    await window.route(`${appOrigin}/**`, (route) => route.abort());
    // The reload itself fails because the whole origin is unreachable; the
    // shell must react to that failure with its local error page.
    await window.reload().catch(() => {});
    await expect(
      window.getByRole('heading', { name: '暂时无法连接到应用' }),
    ).toBeVisible({ timeout: 30_000 });

    await window.unroute(`${appOrigin}/**`);
    await window.getByRole('button', { name: '重新连接' }).click();
    // Retry returns to the shell's last in-app target (the home entry), so
    // the shared views load again instead of the error page.
    await expect(window.getByRole('link', { name: '登录' })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await cleanup();
  }
});

test('the error page continues the chosen language and theme across restarts', async () => {
  test.setTimeout(300_000);
  const appOrigin = new URL(requireSmokeEnv('E2E_WEB_URL')).origin;
  // One profile is deliberately reused across launches: the journey under
  // test is persistence, so the caller owns the directory and its removal.
  const userDataDir = mkdtempSync(
    join(tmpdir(), 'labos-threejs-desktop-error-profile-'),
  );
  try {
    // First run: pick English and dark through the shared settings page.
    const first = await launchApp({ userDataDir });
    await signIn(first.window);
    await first.window.goto(`${appOrigin}/settings`);
    // The settings page renders its language and theme choices as radio
    // groups; English stays readable while the page is zh.
    await first.window.getByRole('radio', { name: 'English' }).click();
    await first.window.getByRole('radio', { name: 'Dark' }).click();
    await expect
      .poll(() => storedPreferences(first.window), { timeout: 10_000 })
      .toEqual({ locale: 'en', theme: 'dark' });
    await first.cleanup();

    // Second run on the same profile: with the origin unreachable, the
    // local error page opens in the mirrored language and theme before any
    // web page could load.
    const second = await launchApp({ userDataDir, pinLocale: false });
    await second.window.route(`${appOrigin}/**`, (route) => route.abort());
    await second.window.reload().catch(() => {});
    await expect(
      second.window.getByRole('heading', {
        name: 'The app is unreachable right now',
      }),
    ).toBeVisible({ timeout: 30_000 });
    expect(
      await second.window.evaluate(() => document.documentElement.lang),
    ).toBe('en');
    expect(
      await second.window.evaluate(() =>
        document.body.classList.contains('dark'),
      ),
    ).toBe(true);

    // Reconnect recovers into the app; the session survived in the
    // partition, so the home surface offers sign-out in English.
    await second.window.unroute(`${appOrigin}/**`);
    await second.window.getByRole('button', { name: 'Reconnect' }).click();
    await expect(
      second.window.getByRole('button', { name: 'Sign out' }),
    ).toBeVisible({ timeout: 30_000 });

    // Switching to the system theme is mirrored too; a later failure page
    // then follows the OS look live, without any reload.
    await second.window.goto(`${appOrigin}/settings`);
    await second.window.getByRole('radio', { name: 'System' }).click();
    await expect
      .poll(() => storedPreferences(second.window), { timeout: 10_000 })
      .toEqual({ locale: 'en', theme: 'system' });
    await second.window.route(`${appOrigin}/**`, (route) => route.abort());
    await second.window.reload().catch(() => {});
    await expect(
      second.window.getByRole('heading', {
        name: 'The app is unreachable right now',
      }),
    ).toBeVisible({ timeout: 30_000 });
    await second.window.emulateMedia({ colorScheme: 'light' });
    await expect
      .poll(() =>
        second.window.evaluate(() => document.body.classList.contains('dark')),
      )
      .toBe(false);
    await second.window.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(() =>
        second.window.evaluate(() => document.body.classList.contains('dark')),
      )
      .toBe(true);
    await second.cleanup();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
