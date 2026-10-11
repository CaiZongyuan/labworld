import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { showObjectDirectory } from '../../tests/e2e/lab-desktop';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { layoutObserver } from './observer';
import { observeRasterPhases } from './lab-raster-phases';
const observers = new WeakMap<Page, ReturnType<typeof layoutObserver>>();
const rasterPhases = new WeakMap<
  Page,
  ReturnType<typeof observeRasterPhases>
>();
let captureOrdinal = 0;
let latestCapture: { attempt: number; png: Buffer } | undefined;
test.use({ locale: 'zh-CN', colorScheme: 'light', actionTimeout: 10000 });
let saveAttempt = 0;
async function register(page: Page, email: string, password: string) {
  await observers
    .get(page)!
    .operation('register.goto', 9, () => page.goto('/register'));
  await observers
    .get(page)!
    .operation('register.email.fill', 10, () =>
      page.getByLabel('邮箱', { exact: true }).fill(email),
    );
  await observers
    .get(page)!
    .operation('register.password.fill', 11, () =>
      page.getByLabel('密码', { exact: true }).fill(password),
    );
  await observers
    .get(page)!
    .operation('register.submit.click', 12, () =>
      page.getByRole('button', { name: '创建账号' }).click(),
    );
  await observers
    .get(page)!
    .operation('register.url.expected', 13, () =>
      expect(page).toHaveURL(/\/lab$/),
    );
}

async function createLab(page: Page, name: string) {
  await observers
    .get(page)!
    .operation('lab.open.click', 17, () =>
      page.getByRole('button', { name: '创建 Lab', exact: true }).click(),
    );
  const dialog = page.getByRole('dialog');
  await observers
    .get(page)!
    .operation('lab.name.fill', 19, () =>
      dialog.getByLabel('名称', { exact: true }).fill(name),
    );
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/lab/labs',
  );
  await observers
    .get(page)!
    .operation('lab.submit.click', 25, () =>
      dialog.getByRole('button', { name: '创建', exact: true }).click(),
    );
  const response = await observers
    .get(page)!
    .operation('lab.response.await', 26, () => created);
  observers
    .get(page)!
    .sync('lab.status201', 27, () => expect(response.status()).toBe(201));
  await observers
    .get(page)!
    .operation('lab.heading.visible', 28, () =>
      expect(page.getByRole('heading', { name, exact: true })).toBeVisible(),
    );
  return (
    await observers
      .get(page)!
      .operation('lab.response.json', 29, () => response.json())
  ).id as string;
}

async function object(page: Page, definition: string, name: string) {
  const phase = definition === 'bench' ? 'bench' : 'beaker';
  await observers
    .get(page)!
    .operation(`${phase}.open.click`, 33, () =>
      page.getByRole('button', { name: '登记对象', exact: true }).click(),
    );
  const dialog = page.getByRole('dialog');
  await observers
    .get(page)!
    .operation(`${phase}.definition.select`, 35, () =>
      dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`),
    );
  await observers
    .get(page)!
    .operation(`${phase}.name.fill`, 36, () =>
      dialog.getByLabel('名称', { exact: true }).fill(name),
    );
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/labs\/[^/]+\/entities$/.test(new URL(response.url()).pathname),
  );
  await observers
    .get(page)!
    .operation(`${phase}.submit.click`, 42, () =>
      dialog.getByRole('button', { name: '登记', exact: true }).click(),
    );
  const response = await observers
    .get(page)!
    .operation(`${phase}.response.await`, 43, () => created);
  observers
    .get(page)!
    .sync('object.status201', 44, () => expect(response.status()).toBe(201));
  try {
    await observers
      .get(page)!
      .operation(`${phase}.dialog.hidden`, 46, () =>
        expect(dialog).toBeHidden(),
      );
    await observers
      .get(page)!
      .operation(`${phase}.heading.visible`, 47, () =>
        expect(page.getByRole('heading', { name, exact: true })).toBeVisible(),
      );
  } catch (cause) {
    if (new URL(page.url()).pathname === '/lab')
      await observers
        .get(page)!
        .operation(`${phase}.L52`, 52, () =>
          page.screenshot({ path: 'test-results/layout-draft-setup.png' }),
        );
    throw cause;
  }
  return (
    await observers
      .get(page)!
      .operation(`${phase}.response.json`, 55, () => response.json())
  ).id as string;
}

async function select(page: Page, name: string) {
  if (
    !(await observers
      .get(page)!
      .operation('select.L60', 60, () =>
        page
          .getByRole('complementary', { name: /^(对象目录|Object directory)$/ })
          .isVisible(),
      ))
  )
    await observers
      .get(page)!
      .operation('select.L64', 64, () => showObjectDirectory(page));
  await observers
    .get(page)!
    .operation('select.L65', 65, () =>
      page.getByRole('button', { name: `选择 ${name}`, exact: true }).click(),
    );
  await observers
    .get(page)!
    .operation('select.L66', 66, () =>
      expect(page.getByRole('heading', { name, exact: true })).toBeVisible(),
    );
}

async function edit(page: Page) {
  await observers
    .get(page)!
    .operation('edit.L70', 70, () =>
      page.getByRole('tab', { name: /^(编辑布局|Edit layout)$/ }).click(),
    );
  const x = page.getByLabel('X (m)', { exact: true });
  await observers
    .get(page)!
    .operation('edit.L72', 72, () => expect(x).toBeVisible());
  return x;
}

async function save(page: Page) {
  const attempt = ++saveAttempt;
  const location = new URL(page.url());
  const labId = location.searchParams.get('lab');
  const entityId = location.searchParams.get('entity');
  const action = page.getByRole('button', {
    name: /^(保存布局|重试保存|Save layout|Retry save)$/,
  });
  const status = page.getByRole('status', {
    name: /^(布局保存状态|Layout save status)$/,
  });
  const response = page
    .waitForResponse(
      (result) =>
        result.request().method() === 'PUT' &&
        new URL(result.url()).pathname === `/api/v1/lab/labs/${labId}/layout`,
      { timeout: 10000 },
    )
    .then(async (result) => {
      const body = await observers
        .get(page)!
        .operation('save.L96', 96, () => result.json().catch(() => null));
      const input = result.request().postDataJSON();
      return {
        status: result.status(),
        code: body?.error?.code ?? null,
        returnedVersion: body?.layout_version ?? null,
        expectedVersion: input?.expected_version ?? null,
      };
    })
    .catch(() => null);
  try {
    await observers
      .get(page)!
      .operation('save.L107', 107, () => action.click());
    await observers
      .get(page)!
      .operation('save.L108', 108, () =>
        expect(status).toHaveText(/^(已保存|Saved)$/),
      );
  } finally {
    const saved = labId
      ? await observers.get(page)!.operation('save.L111', 111, () =>
          page.request
            .get(`/api/v1/lab/labs/${labId}/world`, { timeout: 5000 })
            .then(async (result) => {
              const body = result.ok()
                ? await observers
                    .get(page)!
                    .operation('save.L114', 114, () => result.json())
                : null;
              return {
                status: result.status(),
                layoutVersion: body?.lab?.layout_version ?? null,
                placements:
                  body?.nodes
                    ?.filter(
                      (node: { entity_id: string }) =>
                        node.entity_id === entityId,
                    )
                    .map((node: { placement: unknown }) => node.placement) ??
                  [],
              };
            })
            .catch(() => null),
        )
      : null;
    observers.get(page)!.originalWrite(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        `layout-draft-save-${attempt}.json`,
      ),
      JSON.stringify(
        {
          attempt,
          labId,
          entityId,
          response: await observers
            .get(page)!
            .operation('save.L139', 139, () => response),
          saved,
          uiStatus: await observers
            .get(page)!
            .operation('save.L141', 141, () =>
              status.textContent({ timeout: 1000 }).catch(() => null),
            ),
          disabled: await observers
            .get(page)!
            .operation('save.L144', 144, () =>
              action.isDisabled({ timeout: 1000 }).catch(() => null),
            ),
          rawX: await observers.get(page)!.operation('save.L147', 147, () =>
            page
              .getByLabel('X (m)', { exact: true })
              .inputValue({ timeout: 1000 })
              .catch(() => null),
          ),
        },
        null,
        2,
      ),
    );
  }
}

async function world(page: Page, lab: string) {
  const response = await observers
    .get(page)!
    .operation('world.L160', 160, () =>
      page.request.get(`/api/v1/lab/labs/${lab}/world`),
    );
  observers
    .get(page)!
    .sync('world.status200', 161, () => expect(response.status()).toBe(200));
  return response.json();
}

async function redHandle(page: Page) {
  const observer = observers.get(page)!;
  const attempt = ++captureOrdinal;
  observer.rasterNote('capture-entry', { captureOrdinal: attempt });
  const png = await rasterPhases.get(page)!('canvas-screenshot', () =>
    page.locator('canvas').screenshot(),
  );
  latestCapture = { attempt, png };
  const result = await rasterPhases.get(page)!('pixel-evaluate', () =>
    page.evaluate(
      async ({ encoded, identity }) => {
        const begin = performance.now();
        const mark = (stage: string, count?: number) => {
          try {
            (
              window as unknown as {
                __pm67PrefixState?: { rasterMark: (v: unknown) => void };
              }
            ).__pm67PrefixState?.rasterMark({
              ...identity,
              kind: 'red-handle',
              stage,
              count,
              elapsedMs: performance.now() - begin,
            });
          } catch {
            /* Optional marker cannot replace the original evaluate. */
          }
        };
        mark('entry');
        try {
          const image = new Image();
          image.src = `data:image/png;base64,${encoded}`;
          mark('decode-begin');
          await image.decode();
          mark('decodes-complete');
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            image.width,
            image.height,
          ).data;
          const points: { x: number; y: number }[] = [];
          mark('count-begin');
          for (let index = 0; index < pixels.length; index += 4)
            if (
              pixels[index] > 180 &&
              pixels[index] > pixels[index + 1] * 1.8 &&
              pixels[index] > pixels[index + 2] * 1.8
            )
              points.push({
                x: (index / 4) % image.width,
                y: Math.floor(index / 4 / image.width),
              });
          mark('count-complete', points.length);
          const value = {
            ...(points[Math.floor(points.length * 0.65)] ?? { x: 0, y: 0 }),
            count: points.length,
          };
          mark('end');
          return value;
        } catch (error) {
          mark('error');
          throw error;
        }
      },
      {
        encoded: png.toString('base64'),
        identity: observer.rasterIdentity(attempt),
      },
    ),
  );
  observer.rasterNote('helper-return', { count: result.count });
  return result;
}

test('one browser recovers private layout input while other users and browsers share only saved World', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  const contexts: BrowserContext[] = [];
  const password = 'browser-layout-draft-password';
  const email = `draft-${Date.now()}@example.test`;
  const observer = layoutObserver(page);
  observers.set(page, observer);
  await observer.setup();
  rasterPhases.set(
    page,
    observeRasterPhases(
      process.env.LAB_NODE_EVIDENCE,
      (durationMs) =>
        observer.rasterNote('phase-write', { elapsedMs: durationMs }),
      (phase, state, boundaryAtMs) =>
        observer.rasterNote('operation-boundary', {
          phase,
          state,
          boundaryAtMs,
        }),
    ),
  );
  let verdict: 'error' | 'early-red-handle-poll' = 'error';
  try {
    await observers
      .get(page)!
      .operation('setup.viewport', 203, () =>
        page.setViewportSize({ width: 1440, height: 1000 }),
      );
    await observers
      .get(page)!
      .operation('prefix.register', 205, () => register(page, email, password));
    const lab = await observers
      .get(page)!
      .operation('prefix.lab', 206, () => createLab(page, 'Browser drafts'));
    const bench = await observers
      .get(page)!
      .operation('prefix.bench', 207, () =>
        object(page, 'bench', 'Draft bench'),
      );
    const beaker = await observers
      .get(page)!
      .operation('prefix.beaker', 208, () =>
        object(page, 'labware', 'Draft beaker'),
      );
    await observers
      .get(page)!
      .operation('prefix.select', 209, () => select(page, 'Draft beaker'));
    await observers.get(page)!.operation('prefix.edit', 210, () => edit(page));
    await observers
      .get(page)!
      .operation('prefix.relation.select', 211, () =>
        page.getByLabel('关系对象').selectOption(bench),
      );
    await observers
      .get(page)!
      .operation('prefix.relation.register', 212, () =>
        page.getByRole('button', { name: '登记关系', exact: true }).click(),
      );
    await observers.get(page)!.operation('prefix.save', 213, () => save(page));
    const baseline = await observers
      .get(page)!
      .operation('prefix.world', 214, () => world(page, lab));
    const nodeId = observers
      .get(page)!
      .sync(
        'prefix.node-id',
        215,
        () =>
          baseline.nodes.find(
            (node: { entity_id: string }) => node.entity_id === beaker,
          ).id,
      );
    const placement = (snapshot: typeof baseline, entityId: string) =>
      snapshot.nodes.find(
        (node: { entity_id: string }) => node.entity_id === entityId,
      ).placement.position;
    const y = page.getByLabel('Y (m)', { exact: true });
    await observers
      .get(page)!
      .operation('prefix.y.fill', 223, () => y.fill('-'));
    await observers
      .get(page)!
      .operation('prefix.focus', 224, () =>
        page.getByRole('button', { name: '聚焦模型', exact: true }).click(),
      );
    await observers
      .get(page)!
      .operation('prefix.move', 225, () =>
        page.getByRole('button', { name: '移动', exact: true }).click(),
      );
    await observers
      .get(page)!
      .operation('prefix.early-red-handle-poll', 226, () =>
        expect
          .poll(async () => {
            observer.beginCallback('early-red-handle');
            return (
              await observers
                .get(page)!
                .operation('red-handle.callback', 227, () => redHandle(page))
            ).count;
          })
          .toBeGreaterThan(10),
      );

    verdict = 'early-red-handle-poll';
  } finally {
    observer.rasterNote('whole-outcome', { verdict });
    if (latestCapture && process.env.LAB_NODE_EVIDENCE) {
      try {
        observer.measureWrite('capture-retention', () =>
          writeFileSync(
            join(
              process.env.LAB_NODE_EVIDENCE!,
              'early-handle-latest-completed-capture.png',
            ),
            latestCapture!.png,
          ),
        );
      } catch {
        /* Optional retention preserves original outcome. */
      }
    }
    await observer.finish(verdict);
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
