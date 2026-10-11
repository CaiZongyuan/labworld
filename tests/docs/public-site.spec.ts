import { expect, test, type Page } from '@playwright/test';

// The public Landing, the Documentation entry and the two honest Coming
// soon pages, driven in a real browser against the built static site.
// Run via `just e2e-docs`; no application stack is involved.

// E2E_DOCS_URL carries the deployed base, but page.goto('/') would resolve
// against the bare origin — every journey goes through this helper so the
// base always stays in the URL.
const site = new URL(process.env.E2E_DOCS_URL ?? 'http://127.0.0.1:0/');
const go = (page: Page, path = '/') =>
  page.goto(site.pathname.replace(/\/$/, '') + path);

test('the landing offers section navigation and local documentation actions', async ({
  page,
}) => {
  await go(page);
  await expect(page).toHaveTitle(/Lab Word/);
  await expect(page.locator('.topnav nav a[href="#devices"]')).toHaveText(
    '设备',
  );
  await expect(page.locator('.topnav nav a[href="#start"]')).toHaveText('开始');
  await expect(
    page.locator('.hero-meta .cta').getByRole('link', { name: '阅读文档' }),
  ).toHaveAttribute('href', /\/docs\/$/);
  await expect(
    page
      .locator('.hero-meta .cta')
      .getByRole('link', { name: '在 GitHub 查看' }),
  ).toHaveAttribute('href', /github\.com/);
  await expect(
    page.locator('footer').getByRole('link', { name: '博客', exact: true }),
  ).toHaveAttribute('href', /\/blog\/$/);
  await expect(
    page.locator('footer').getByRole('link', { name: '下载', exact: true }),
  ).toHaveAttribute('href', /\/downloads\/$/);
  await expect(page.locator('.demo-note')).toContainText('未连接你的 Lab');
  await expect(page.locator('#architecture')).toContainText('后续方向');
  await expect(page.locator('.labword-landing')).not.toContainText(
    /Rust API|PostgreSQL|legacy-rust-final|此前 · 服务群/,
  );
});

test('the primary CTA enters the Chinese documentation and old deep links keep working', async ({
  page,
}) => {
  await go(page, '/');
  await page
    .locator('.hero-meta .cta')
    .getByRole('link', { name: '阅读文档' })
    .click();
  await expect(page).toHaveURL(/\/docs\/$/);
  await expect(
    page.getByRole('heading', { name: 'Lab Word 项目文档', level: 1 }),
  ).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(
    /labword-landing-mode|after-dark/,
  );
  await go(page, '/getting-started/quickstart');
  await expect(
    page.getByRole('heading', { level: 1 }).filter({ hasText: '快速开始' }),
  ).toBeVisible();
});

test('developers can follow structure to module boundaries in either language', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(page, '/architecture/project-structure');
  await expect(
    page.getByRole('heading', { level: 1, name: '项目结构' }),
  ).toBeVisible();
  const sidebar = await page.locator('.VPSidebar').boundingBox();
  const navigation = await page.locator('#VPSidebarNav').boundingBox();
  expect(sidebar?.x).toBe(0);
  expect(sidebar?.width).toBe(264);
  expect(navigation?.x).toBeLessThanOrEqual(32);
  await page.locator('.pager-link.next').click();
  await expect(page).toHaveURL(/\/architecture\/module-boundaries$/);
  await expect(
    page.getByRole('heading', { level: 1, name: '模块边界' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '应用入口' })).toHaveAttribute(
    'href',
    /apps\/web\/src\/app\.ts$/,
  );
  await page.locator('.docs-locale-link').click();
  await expect(page).toHaveURL(/\/en\/architecture\/module-boundaries$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Module Boundaries' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'application entry' }),
  ).toHaveAttribute('href', /apps\/web\/src\/app\.ts$/);
});

test('blog and downloads are direct Coming soon pages without fabricated content', async ({
  page,
}) => {
  for (const [path, heading, backName] of [
    ['/blog/', '博客 · 即将推出', '首页'],
    ['/downloads/', '下载 · 即将推出', '首页'],
  ] as const) {
    await go(page, path);
    await expect(
      page.getByRole('heading', { level: 1, name: heading }),
    ).toBeVisible();
    // The styled container exists and carries the mono badge; the page
    // content itself is untouched honest prose.
    await expect(page.locator('.placeholder')).toBeVisible();
    await expect(page.locator('.placeholder-badge')).toHaveText('即将推出');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    // Honest placeholder: no article list, no asset table, no download
    // buttons, no dates posed as release dates.
    await expect(page.locator('article, table, [download], time')).toHaveCount(
      0,
    );
    await page.getByRole('link', { name: backName }).first().click();
    await expect(page).toHaveURL(/\/$/);
  }
  const meta = page.locator('meta[name="description"]');
  await go(page, '/blog/');
  await expect(meta).toHaveAttribute('content', /尚未开始实现/);
  await go(page, '/downloads/');
  await expect(meta).toHaveAttribute('content', /尚未开始实现/);
});

test('local search finds the Lab guide and keeps its locale', async ({
  page,
}) => {
  for (const [path, button, query] of [
    ['/docs/', '搜索文档', '使用 Lab 与资产库'],
    ['/en/docs/', 'Search docs', 'Use Lab And The Asset Library'],
  ] as const) {
    await go(page, path);
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.getByRole('searchbox').fill(query);
    const result = page.locator('.VPLocalSearchBox').getByRole('link').first();
    await expect(result).toHaveAttribute('href', /\/guides\/lab-viewer#/);
    await result.click();
    await expect(page).toHaveURL(
      path.startsWith('/en/')
        ? /\/en\/guides\/lab-viewer#/
        : /\/guides\/lab-viewer#/,
    );
    await expect(
      page.getByRole('heading', { level: 1, name: query }),
    ).toBeVisible();
  }
});

test('the English coming soon pages carry honest English meta', async ({
  page,
}) => {
  for (const [path, title, heading] of [
    ['/en/blog/', /Blog · Coming soon/, 'Blog · Coming soon'],
    ['/en/downloads/', /Downloads · Coming soon/, 'Downloads · Coming soon'],
  ] as const) {
    await go(page, path);
    await expect(page).toHaveTitle(title);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('heading', { level: 1, name: heading }),
    ).toBeVisible();
    // The styled container mirrors the Chinese pages.
    await expect(page.locator('.placeholder')).toBeVisible();
    await expect(page.locator('.placeholder-badge')).toHaveText('Coming soon');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /not implemented yet/,
    );
  }
});

test('documentation linked from settings and the showroom stays available', async ({
  page,
}) => {
  for (const [path, heading] of [
    ['/tutorials/appearance-language', '外观与语言'],
    ['/tutorials/design-system', '共享界面组件'],
    ['/en/tutorials/appearance-language', 'Appearance And Language'],
    ['/en/tutorials/design-system', 'Shared Interface Components'],
  ]) {
    await go(page, path);
    await expect(
      page.getByRole('heading', { level: 1, name: heading }),
    ).toBeVisible();
  }
});

test('the language switcher lands on the same page in the other locale', async ({
  page,
}) => {
  await go(page, '/blog/');
  await page.getByRole('link', { name: 'English', exact: true }).click();
  await expect(page).toHaveURL(/\/en\/blog\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('link', { name: '中文', exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test('the landing CTA and switcher also work from the English home', async ({
  page,
}) => {
  await go(page, '/en/');
  await expect(page.locator('.hero-head h1')).toContainText(
    'after you close the tab',
  );
  await page.locator('#lang').click();
  await expect(page).toHaveURL(new RegExp(site.pathname + '$'));
  await expect(page.locator('.hero-head h1')).toContainText('关掉标签页');
  await page.locator('#lang').click();
  await expect(page).toHaveURL(/\/en\/$/);
  await page
    .locator('.hero-meta .cta')
    .getByRole('link', { name: 'Read the docs' })
    .click();
  await expect(page).toHaveURL(/\/en\/docs\/$/);
});

test('the project home renders the actual application and identifies its status', async ({
  page,
}) => {
  for (const [path, status] of [
    ['/', '真实的应用栈'],
    ['/en/', 'real application stack'],
  ]) {
    await go(page, path);
    const application = page.locator('.shot img');
    await application.scrollIntoViewIfNeeded();
    await expect(page.locator('.shot')).toContainText(status);
    await expect(application).toBeVisible();
    await expect
      .poll(() =>
        application.evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1440);
  }
  for (const width of [320, 390, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await go(page, '/');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test('the interactive landing survives document navigation and shares the saved theme', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Observe browser-owned intervals rather than the landing module's private state.
  await page.addInitScript(() => {
    const intervals = new Set<number>();
    const schedule = window.setInterval.bind(window);
    const cancel = window.clearInterval.bind(window);
    window.setInterval = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      const id = schedule(handler, delay, ...args);
      if (delay === 200) intervals.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) intervals.delete(id);
      cancel(id);
    }) as typeof window.clearInterval;
    Object.defineProperty(window, 'landingIntervals', {
      get: () => intervals.size,
    });
  });
  const intervals = () =>
    page.evaluate(() => Reflect.get(window, 'landingIntervals'));
  await go(page);
  await expect(page.locator('#readout')).toContainText('实时');
  await expect.poll(intervals).toBe(1);
  await page.locator('#pause').click();
  await expect(page.locator('#pause')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#pause').click();
  await page.locator('.plate').scrollIntoViewIfNeeded();
  const canvas = await page.locator('#view').boundingBox();
  if (!canvas) throw new Error('The laboratory illustration is not visible.');
  await page.mouse.click(
    canvas.x + canvas.width * 0.588674,
    canvas.y + canvas.height * 0.341177,
  );
  await expect(page.locator('#cardTitle')).toHaveText('灯 B');
  const toggle = page.locator('#cardFoot [data-act="toggle"]');
  await toggle.click();
  await expect(toggle).toHaveText('停止');
  await toggle.click();
  await expect(toggle).toHaveText('启动');
  const light = page.locator('#dev-light');
  await light.getByRole('button', { name: '启动', exact: true }).click();
  await expect(light.locator('[data-f="run"]')).toHaveText('实时');
  await light.getByRole('button', { name: '设为 100 %', exact: true }).click();
  await expect(light.locator('[data-f="obs"]')).toHaveText('100 %');
  await page.locator('#mode').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page
    .locator('.hero-meta .cta')
    .getByRole('link', { name: '阅读文档' })
    .click();
  await expect(page.locator('.vp-doc h1')).toHaveText('Lab Word 项目文档');
  await expect.poll(intervals).toBe(0);
  await expect(page.locator('html')).not.toHaveClass(
    /labword-landing-mode|after-dark/,
  );
  await page.locator('.VPNavBarMenuLink').filter({ hasText: '首页' }).click();
  await expect(page.locator('#readout')).toContainText('实时');
  await expect.poll(intervals).toBe(1);
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(errors).toEqual([]);
});

test('the moving robot remains visible when its arm swings over the cart', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    let now: number | undefined;
    window.requestAnimationFrame = (callback) => {
      callbacks.set(++id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => callbacks.delete(id);
    Reflect.set(window, 'advanceLanding', (frames: number) => {
      now ??= performance.now();
      for (let frame = 0; frame < frames; frame++) {
        now += 50;
        const batch = [...callbacks.values()];
        callbacks.clear();
        for (const callback of batch) callback(now);
      }
    });
  });
  await go(page, '/en/');
  const canvas = page.locator('#view');
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
    .toBeGreaterThan(1000);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document
      .querySelector('.plate')
      ?.scrollIntoView({ behavior: 'instant', block: 'start' });
    Reflect.get(window, 'advanceLanding')(61);
  });
  const exposure = await canvas.evaluate((element: HTMLCanvasElement) => {
    const rect = element.getBoundingClientRect();
    const exposed =
      document.elementFromPoint(
        rect.x + rect.width * 0.51,
        rect.y + rect.height * 0.7,
      ) === element;
    // At this pose the upper link is above the base. Invalid depth values used
    // to let the static scene paint over it; measure the final visible pixels.
    const pixels = element
      .getContext('2d')!
      .getImageData(
        Math.round(element.width * 0.5),
        Math.round(element.height * 0.686),
        Math.round(element.width * 0.025),
        Math.round(element.height * 0.044),
      ).data;
    let visible = 0;
    for (let pixel = 0; pixel < pixels.length; pixel += 4) {
      if (
        pixels[pixel] < 180 &&
        pixels[pixel + 1] < 180 &&
        pixels[pixel + 2] < 180 &&
        pixels[pixel + 3] > 0
      )
        visible++;
    }
    return { exposed, visible };
  });
  expect(exposure.exposed).toBe(true);
  expect(exposure.visible).toBeGreaterThan(240);
});

test('history continues to the lifecycle tutorial and language switching keeps that chapter', async ({
  page,
}) => {
  await go(page, '/tutorials/run-history');
  await page.locator('.pager-link.next').click();
  await expect(page).toHaveURL(/\/tutorials\/bounded-trends$/);
  await page.locator('.pager-link.next').click();
  await expect(page).toHaveURL(/\/tutorials\/entity-lifecycle$/);
  await expect(
    page.getByRole('heading', { level: 1, name: '归档对象并替换外观' }),
  ).toBeVisible();
  await page.getByRole('banner').getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en\/tutorials\/entity-lifecycle$/);
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Archive An Entity And Replace Its Appearance',
    }),
  ).toBeVisible();
  await expect(page.locator('.vp-doc')).toContainText('409 lab.entity_in_use');
  await expect(page.locator('.pager-link.prev')).toHaveAttribute(
    'href',
    /\/en\/tutorials\/bounded-trends$/,
  );
});

test('the three-state appearance control covers system, light and dark', async ({
  page,
}) => {
  await go(page, '/docs/');
  // The navbar hosts the control from 960px; the nav-screen copy only
  // mounts with the hamburger, so the match stays unambiguous.
  const dark = page.getByRole('button', { name: '深色', exact: true });
  await dark.click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/); // survives a reload
  const light = page.getByRole('button', { name: '浅色', exact: true });
  await light.click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  const system = page.getByRole('button', { name: '跟随系统', exact: true });
  await system.click();
  // Playwright defaults to a light color scheme, so 'auto' stays light…
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  // …and follows the OS live, without a reload.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('the complete Foundation path preserves every chapter, language and narrow layout', async ({
  page,
}) => {
  const chapters = [
    'persistent-assets',
    'persistent-world',
    'spatial-workbench',
    'device-details',
    'device-trends',
    'backend-lights',
    'edit-layout',
    'layout-drafts',
    'reliable-sync',
    'continuous-temperature',
    'centrifuge-tasks',
    'run-history',
    'bounded-trends',
    'entity-lifecycle',
    'guide-progress',
  ];
  for (const prefix of ['', '/en']) {
    await go(page, `${prefix}/tutorials/${chapters[0]}`);
    for (const [index, chapter] of chapters.entries()) {
      await expect(page).toHaveURL(
        new RegExp(`${prefix}/tutorials/${chapter}$`),
      );
      await expect(page.locator('.vp-doc h1')).toBeVisible();
      if (
        ![
          'spatial-workbench',
          'device-details',
          'device-trends',
          'layout-drafts',
          'bounded-trends',
          'guide-progress',
        ].includes(chapter)
      ) {
        const commonStart = page
          .locator('.vp-doc a[href$="complete-foundation"]')
          .first();
        await expect
          .poll(() =>
            commonStart.evaluate(
              (link: HTMLAnchorElement) => new URL(link.href).pathname,
            ),
          )
          .toBe(
            site.pathname.replace(/\/$/, '') +
              `${prefix}/tutorials/complete-foundation`,
          );
      }
      if (index < chapters.length - 1)
        await page.locator('.pager-link.next').click();
    }
    await expect(page.locator('.pager-link.next')).toHaveCount(0);
    await go(page, `${prefix}/tutorials/complete-foundation`);
    await expect(page.locator('.vp-doc')).toContainText(
      'tests/e2e/lab-reference-load.spec.ts',
    );
    await expect(page.locator('.pager-link.next')).toHaveCount(0);
    await expect(page.locator('.pager-link.prev')).toHaveAttribute(
      'href',
      /\/tutorials\/entity-lifecycle$/,
    );
  }
  await page
    .getByRole('banner')
    .getByRole('link', { name: '中文', exact: true })
    .click();
  await expect(page).toHaveURL(/\/tutorials\/complete-foundation$/);
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '.scratch/foundation-v1/documentation/complete-mobile-zh-dark.png',
    fullPage: true,
  });
  await go(page, '/en/tutorials/complete-foundation');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Complete Digital Laboratory Journey',
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '.scratch/foundation-v1/documentation/complete-mobile-en-dark.png',
    fullPage: true,
  });
});

test('the shared chrome keeps gutters, the language pill and the license line', async ({
  page,
}) => {
  await go(page, '/blog/');
  // The pill and the appearance control join the navbar right cluster
  // from 960px — including the 960–1279 range where VitePress shows
  // neither its hamburger nor its own appearance toggle.
  await expect(page.locator('.docs-locale-nav')).toBeVisible();
  await expect(page.locator('.docs-appearance-nav')).toBeVisible();
  const copyright = page.locator('.VPFooter .copyright');
  await expect(copyright).toContainText('MIT');
  await expect(copyright.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
    'href',
    /github\.com/,
  );
  // Every width keeps horizontal gutters: the `page` layout has no styles
  // of its own, so the wrappers provide them.
  await page.setViewportSize({ width: 390, height: 720 });
  await go(page, '/blog/');
  const heroHeading = await page.locator('.placeholder h1').boundingBox();
  expect(heroHeading?.x).toBeGreaterThan(0);
  await go(page, '/blog/');
  const placeholderHeading = await page
    .locator('.placeholder h1')
    .boundingBox();
  expect(placeholderHeading?.x).toBeGreaterThan(0);
  // Below 960px the navbar pills hide and the nav screen carries both.
  await expect(page.locator('.docs-locale-nav')).not.toBeVisible();
  await expect(page.locator('.docs-appearance-nav')).not.toBeVisible();
  await page.getByRole('button', { name: 'mobile navigation' }).click();
  // The screen copies are the only language and theme controls below
  // 960px: reachable by role and sized for the 44px touch floor of
  // design.md §5.
  await expect(
    page.locator('.docs-locale-screen').getByRole('link', { name: 'English' }),
  ).toBeVisible();
  await expect(
    page.locator('.docs-appearance-screen').getByRole('button'),
  ).toHaveCount(3);
  const option = page
    .locator('.docs-appearance-screen .docs-appearance-option')
    .first();
  expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const locale = page.locator('.docs-locale-screen .docs-locale-link');
  expect((await locale.boundingBox())?.height).toBeGreaterThanOrEqual(44);
});

test('narrow-screen navigation reaches the four entries with the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await go(page, '/docs/');
  const hamburger = page.getByRole('button', { name: 'mobile navigation' });
  await hamburger.focus();
  await expect(hamburger).toBeFocused();
  await page.keyboard.press('Enter');
  const screen = page.locator('.VPNavScreen');
  await expect(screen).toBeVisible();
  for (const name of ['首页', '文档', '博客', '下载']) {
    await expect(
      screen.locator('.VPNavScreenMenuLink', { hasText: name }),
    ).toBeVisible();
  }
  // The screen's focus order starts at its menu; walk Tab until the
  // documentation entry holds focus (skip-to-content and the locale
  // switcher sit in between) and follow it with Enter.
  for (let tabs = 0; tabs < 8; tabs++) {
    const focused = await page.evaluate(() =>
      document.activeElement?.textContent?.trim(),
    );
    if (focused === '文档') break;
    await page.keyboard.press('Tab');
  }
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.textContent?.trim()),
    )
    .toBe('文档');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/docs\/$/);
});

test('the landing ships representative visual evidence for both widths', async ({
  page,
}) => {
  await go(page, '/');
  await page.screenshot({
    path: 'test-results/docs/landing-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 720 });
  await expect(page.locator('#lang')).toBeVisible();
  await page.screenshot({
    path: 'test-results/docs/landing-narrow.png',
    fullPage: true,
  });
});

test('the landing ships dark visual evidence as well', async ({ page }) => {
  await go(page, '/');
  // A fresh context stores no preference, so the appearance control's
  // default ('auto') drives the page from the emulated OS scheme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({
    path: 'test-results/docs/landing-desktop-dark.png',
    fullPage: true,
  });
});
