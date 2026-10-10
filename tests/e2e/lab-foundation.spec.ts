import { expectInitialSceneReady } from './initial-scene-ready';
import {
  showObjectDirectory,
  showEntityDetails,
  showEntityOperations,
} from './lab-desktop';
import {
  boundedBrowserFact,
  observeBrowserFailure,
  observeBrowserSeam,
} from './lab-browser-facts';
import { releaseFrameTraces, startFrameTrace } from './lab-frame-trace';
import { observeResourceTiming } from './lab-resource-timing';
import { expect, test, type CDPSession } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { type LabEntity } from '../../packages/sdk/src/index';
import {
  evidence,
  member,
  world,
  chapter,
  capture,
  retainFailure,
} from './lab-foundation-support';

const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });
test.afterEach(releaseFrameTraces);
test.afterEach(retainFailure);

test('the 320px Lab keeps its complete 3D viewport and Inspector above history without a clipped workspace', async ({
  page,
}) => {
  test.skip(
    desktopMigration,
    'Product narrow-screen coverage resumes after Migration Gate',
  );
  const { agent } = await member(page);
  try {
    if (!desktopMigration)
      await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('名称', { exact: true })
      .fill('Mobile Lab');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '创建', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Mobile Lab', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '登记对象', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('定义版本')
      .selectOption('robot@1.0');
    await page
      .getByRole('dialog')
      .getByLabel('名称', { exact: true })
      .fill('Static Robot');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '登记', exact: true })
      .click();
    await page
      .getByRole('button', { name: '选择 Static Robot', exact: true })
      .click();
    await expect(
      page
        .getByRole('complementary', { name: '对象信息' })
        .getByRole('heading', { name: 'Static Robot', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const { body, viewport, inspector, history } = await page.evaluate(() => {
      const rect = (selector: string) => {
        const { x, y, width, height } = document
          .querySelector(selector)!
          .getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        body: rect('.world-body'),
        viewport: rect('.world-viewport'),
        inspector: rect('.world-inspector'),
        history: rect('.world-history'),
      };
    });
    writeFileSync(
      `${evidence}/mobile-layout.json`,
      JSON.stringify({ body, viewport, inspector, history }, null, 2),
    );
    expect(viewport.height).toBeGreaterThanOrEqual(360);
    expect(body.y + body.height).toBeGreaterThanOrEqual(
      viewport.y + viewport.height,
    );
    expect(inspector.y).toBeGreaterThanOrEqual(viewport.y + viewport.height);
    expect(history.y).toBeGreaterThanOrEqual(inspector.y + inspector.height);
    await capture(page, 'mobile-static-robot-zh');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await agent.dispose();
  }
});

test('the bilingual teaching chapters continue one empty Lab with a Member and Agent', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  const { agent, secret, headers } = await member(page);
  let second;
  let resourceTiming: ReturnType<typeof observeResourceTiming> | undefined;
  try {
    await page.getByRole('button', { name: '创建 Lab', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('名称', { exact: true })
      .fill('Complete Foundation Lab');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '创建', exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'Complete Foundation Lab',
        exact: true,
      }),
    ).toBeVisible();
    const labs = await (await agent.get('/api/v1/lab/labs')).json();
    const lab = labs.data.find(
      (entry: { name: string }) => entry.name === 'Complete Foundation Lab',
    ).id;
    const env = {
      LAB_API_BASE: process.env.E2E_API_URL!,
      LAB_API_KEY: secret,
      LAB_ID: lab,
    };
    const imported = chapter('import-asset', env, [
      'tests/fixtures/lab/cube-draco.glb',
    ]);
    await page.getByRole('link', { name: '资产库', exact: true }).click();
    for (const category of [
      'location',
      'furniture',
      'iot',
      'sensor',
      'instrument',
      'robot',
      'labware',
      'model',
    ])
      await expect(
        page
          .getByRole('combobox', { name: '资产类别' })
          .locator(`option[value="${category}"]`),
      ).toHaveCount(1);
    await page
      .getByLabel('GLB 文件')
      .setInputFiles('tests/fixtures/lab/cube-basis.glb');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '发布资产' })
      .click();
    await expect(
      page.getByText('cube-basis.glb', { exact: true }),
    ).toBeVisible();
    const assets = await (await agent.get('/api/v1/lab/assets')).json();
    const basis = assets.data.find(
      (asset: { name: string }) => asset.name === 'cube-basis',
    );
    await page.getByRole('link', { name: 'Lab', exact: true }).click();
    await page.getByRole('combobox', { name: '打开 Lab' }).selectOption(lab);
    await showObjectDirectory(page);
    for (const [definition, name, representation] of [
      ['model', 'Member model', basis.representation.id],
      ['environment', 'Environment', ''],
    ]) {
      await page.getByRole('button', { name: '登记对象', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('定义版本').selectOption(`${definition}@1.0`);
      await dialog.getByLabel('外观表示').selectOption(representation);
      await dialog.getByLabel('名称', { exact: true }).fill(name);
      await dialog.getByRole('button', { name: '登记', exact: true }).click();
      await expect(
        page.getByRole('button', { name: `选择 ${name}`, exact: true }),
      ).toBeVisible();
    }
    const identities = chapter('register-world', env);
    expect(identities.lab_id).toBe(lab);
    const layout = chapter('edit-layout', env);
    writeFileSync(
      `${evidence}/layout-continuity.json`,
      JSON.stringify({ expectedLab: lab, actualLab: layout.lab_id }),
    );
    expect(layout.lab_id).toBe(lab);
    const lighting = chapter('control-lights', env);
    expect(lighting.lab_id).toBe(lab);
    const temperature = chapter('observe-temperature', env);
    expect(temperature.lab_id).toBe(lab);
    const centrifuges = chapter('run-centrifuges', env);
    expect(centrifuges.lab_id).toBe(lab);
    const snapshot = chapter('observe-world', env, ['--once']);
    expect(snapshot.type).toBe('snapshot');
    const history = chapter('query-history', {
      ...env,
      LAB_ENTITY_ID: centrifuges.devices[0].entity_id,
    });
    expect(history.history.task.items[0].data.result.status).toBe('completed');
    const current = await world(agent, lab);
    expect(current.entities).toHaveLength(15);
    expect(
      current.relationships.every((relation) => relation.source === 'manual'),
    ).toBe(true);
    expect(
      current.entities
        .filter((entity) => entity.definition_id === 'robot')
        .every((entity) => !entity.binding),
    ).toBe(true);
    const device = centrifuges.devices[0].entity_id;
    const path = `/api/v1/lab/labs/${lab}/entities/${device}`;
    const before: LabEntity = await (await agent.get(path)).json();
    await expect(
      page.getByRole('button', {
        name: '选择 Tutorial centrifuge A',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '选择 Tutorial centrifuge A', exact: true })
      .click();
    const inspector = page.getByRole('complementary', { name: '对象信息' });
    await expect(
      inspector.getByRole('heading', {
        name: 'Tutorial centrifuge A',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '编辑布局', exact: true }).click();
    await inspector.getByLabel('X (m)', { exact: true }).fill('2.25');
    second = await browser.newContext({
      storageState: await page.context().storageState(),
      locale: 'zh-CN',
    });
    const observer = await second.newPage();
    resourceTiming = observeResourceTiming(observer);
    observer.on('pageerror', (error) => errors.push(error.name));
    const browserFailure = observeBrowserFailure(observer);
    const frameTrace = await startFrameTrace(
      observer,
      'observer-readiness-frame-trace.json',
      test.info(),
      [page],
    );
    const readinessStart = performance.now();
    const readinessResponses: Record<string, unknown>[] = [];
    observer.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (
        !path.endsWith('/world') &&
        !path.includes('/lab-assets/') &&
        !path.startsWith('/objects/') &&
        !path.endsWith('/download')
      )
        return;
      const fact: Record<string, unknown> = {
        order: readinessResponses.length,
        seenAtMs: performance.now() - readinessStart,
        path,
        status: response.status(),
      };
      readinessResponses.push(fact);
      if (path.endsWith('.hdr')) frameTrace.mark('hdr-response');
      if (path.endsWith('/world') && response.ok())
        void response
          .json()
          .then((value) => {
            fact.world = {
              version: value.version,
              labId: value.lab.id,
              entities: value.entities.length,
              nodes: value.nodes.length,
              assets: value.assets.length,
            };
            fact.parsedAtMs = performance.now() - readinessStart;
            frameTrace.mark('world-parsed');
          })
          .catch(() => {
            fact.bodyAvailable = false;
          });
    });
    await observer.goto('/lab');
    resourceTiming.capture('post-goto');
    const selectFailure = observeBrowserSeam(observer, 'foundation-lab-select');
    try {
      await observer
        .getByRole('combobox', { name: '打开 Lab' })
        .selectOption(lab);
    } catch (error) {
      await selectFailure().catch(() => {});
      throw error;
    }
    await showObjectDirectory(observer);
    let observerReady = false;
    frameTrace.mark('assertion-start');
    resourceTiming.capture('assertion-start');
    void frameTrace.captureActiveDocuments();
    try {
      await expectInitialSceneReady(observer.locator('.world-page'));
      observerReady = true;
    } finally {
      frameTrace.mark('assertion-end');
      resourceTiming.mark('assertion-end');
      if (!observerReady)
        await (async () => {
          const assertionEndedAtMs = performance.now() - readinessStart;
          const [browserFacts, domFact] = await Promise.all([
            browserFailure(),
            boundedBrowserFact(() =>
              observer.locator('.world-page').evaluate(
                (root) => {
                  const visible = (element: Element | null) =>
                    !!element &&
                    element.getClientRects().length > 0 &&
                    getComputedStyle(element).visibility === 'visible';
                  const canvas = root?.querySelector('canvas');
                  const version = root?.querySelector(
                    '[aria-label="世界版本"]',
                  )?.textContent;
                  const selected = (
                    root?.querySelector(
                      'select[aria-label="打开 Lab"]',
                    ) as HTMLSelectElement | null
                  )?.value;
                  return {
                    busy: root?.getAttribute('aria-busy'),
                    selectedLab: /^[0-9a-f-]{36}$/i.test(selected ?? '')
                      ? selected
                      : null,
                    worldLabel: /^W\d+$/.test(version ?? '') ? version : null,
                    headingVisible: visible(root?.querySelector('h1') ?? null),
                    loadingVisible: visible(
                      root?.querySelector('.lab-loading') ?? null,
                    ),
                    renderErrorVisible: visible(
                      root?.querySelector('.world-render-error') ?? null,
                    ),
                    canvas: {
                      count: root?.querySelectorAll('canvas').length ?? 0,
                      visible: visible(canvas ?? null),
                      width: canvas?.width,
                      height: canvas?.height,
                    },
                  };
                },
                undefined,
                { timeout: 250 },
              ),
            ),
          ]);
          const dom = domFact.status === 'ack' ? domFact.value : null;
          frameTrace.mark('ack-capture-end');
          const expectedLabPath = new URL(observer.url()).pathname === '/lab';
          let viewportCapture: Record<string, unknown> = {
            status: 'skipped',
            expectedLabPath,
          };
          if (
            process.env.LAB_NODE_EVIDENCE &&
            /^[0-9a-f-]{36}$/i.test(lab) &&
            expectedLabPath
          ) {
            let session: CDPSession | undefined;
            let captureOpen = true;
            const started = performance.now();
            const viewport = await boundedBrowserFact(async () => {
              const owned = await observer.context().newCDPSession(observer);
              if (!captureOpen) {
                void owned.detach().catch(() => {});
                throw new Error('Capture deadline');
              }
              session = owned;
              const result = await owned.send('Page.captureScreenshot', {
                format: 'png',
                fromSurface: true,
                captureBeyondViewport: false,
              });
              return result.data;
            });
            captureOpen = false;
            void session?.detach().catch(() => {});
            viewportCapture = {
              status: viewport.status,
              elapsedMs: viewport.elapsedMs,
              expectedLabPath,
              ...(viewport.status === 'error'
                ? { errorName: viewport.errorName }
                : {}),
            };
            if (viewport.status === 'ack')
              try {
                writeFileSync(
                  `${process.env.LAB_NODE_EVIDENCE}/observer-readiness.png`,
                  Buffer.from(viewport.value, 'base64'),
                );
              } catch {
                viewportCapture = {
                  status: 'write-error',
                  elapsedMs: performance.now() - started,
                  expectedLabPath,
                };
              }
          }
          writeFileSync(
            `${process.env.LAB_NODE_EVIDENCE}/observer-readiness.json`,
            JSON.stringify({
              expectedLab: lab,
              assertionEndedAtMs,
              capturedAtMs: performance.now() - readinessStart,
              browserFacts,
              viewportCapture,
              domCapture: {
                status: domFact.status,
                elapsedMs: domFact.elapsedMs,
                ...(domFact.status === 'error'
                  ? { errorName: domFact.errorName }
                  : {}),
              },
              dom,
              responses: readinessResponses,
            }) + '\n',
          );
        })().catch(() => {
          // Optional diagnostics preserve the original readiness failure.
        });
      await frameTrace.finish(true);
      await resourceTiming.finish();
    }
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('连接中断', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(inspector.getByLabel('X (m)', { exact: true })).toHaveValue(
      '2.25',
    );
    await capture(page, 'offline-draft');
    await page.context().setOffline(false);
    await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
    await expect(inspector.getByLabel('X (m)', { exact: true })).toHaveValue(
      '2.25',
    );
    await page.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
      '已保存',
    );
    expect(
      (await world(agent, lab)).nodes.find((node) => node.entity_id === device)!
        .placement.position[0],
    ).toBe(2.25);
    expect((await world(agent, lab)).relationships).toEqual(
      current.relationships,
    );
    await inspector
      .getByRole('button', { name: '移除节点', exact: true })
      .click();
    await page.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
      '已保存',
    );
    const removed = await world(agent, lab);
    expect(removed.nodes.some((node) => node.entity_id === device)).toBe(false);
    const retained = removed.entities.find((entity) => entity.id === device)!;
    for (const field of ['binding', 'task', 'task_result'] as const)
      expect(retained[field]).toEqual(before[field]);
    await inspector
      .getByRole('button', { name: '新增同一对象表示', exact: true })
      .click();
    await page.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect(page.getByRole('status', { name: '布局保存状态' })).toHaveText(
      '已保存',
    );
    expect(
      (await world(agent, lab)).nodes.some((node) => node.entity_id === device),
    ).toBe(true);
    await showEntityOperations(page);
    await inspector
      .getByRole('button', { name: '停止程序', exact: true })
      .click();
    const lifecycle = chapter('manage-entity', {
      ...env,
      LAB_ENTITY_ID: device,
      LAB_REPRESENTATION_ID: imported.representation_id,
      LAB_ASSET_ID: imported.id,
    });
    expect(lifecycle.entity).toBe(device);
    expect(lifecycle.archived_at).toBeTruthy();
    const archived: LabEntity = await (await agent.get(path)).json();
    expect(archived.task?.id).toBe(before.task?.id);
    expect(archived.task_result?.id).toBe(before.task_result?.id);
    expect((await agent.get(`${path}/tasks/${before.task!.id}`)).status()).toBe(
      200,
    );
    expect(
      (await page.request.post(`${path}/program/start`, { headers })).status(),
    ).toBe(409);
    await showEntityDetails(page);
    await expect(
      page.getByText('已归档', { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('tab', { name: '运行查看', exact: true }).click();
    await page.getByRole('button', { name: '使用中对象', exact: true }).click();
    await page
      .getByRole('button', { name: '选择 Light B', exact: true })
      .click();
    await inspector.getByRole('switch', { name: '电源', exact: true }).click();
    await expect(
      inspector.getByRole('switch', { name: '电源', exact: true }),
    ).not.toBeChecked();
    const light = (await world(agent, lab)).entities.find(
      (entity) => entity.name === 'Light B',
    )!;
    expect(light.observation?.values).toEqual(
      expect.objectContaining({ on: false, brightness: 20 }),
    );
    const lightPath = `/api/v1/lab/labs/${lab}/entities/${light.id}`;
    const invalid = {
      capability: 'light.set_brightness',
      parameters: { brightness: 101 },
    };
    for (const actor of [agent, page.request]) {
      const response = await actor.post(`${lightPath}/actions`, {
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        data: invalid,
      });
      expect(response.status()).toBe(422);
      expect((await response.json()).error.code).toBe('lab.invalid_parameters');
    }
    expect(
      (
        await page.request.post(`${lightPath}/actions`, {
          headers: {
            origin: process.env.E2E_WEB_URL!,
            'idempotency-key': crypto.randomUUID(),
          },
          data: { capability: 'light.set_power', parameters: { on: true } },
        })
      ).status(),
    ).toBe(403);
    expect(
      (await (await agent.get(lightPath)).json()).observation.values,
    ).toEqual(light.observation?.values);
    await inspector.evaluate((element) => {
      element.scrollTop = 0;
    });
    await capture(page, 'complete-desktop-zh');
    for (const entity of (await world(agent, lab)).entities.filter(
      (entry) => entry.program_run?.status === 'running',
    )) {
      expect(
        (
          await agent.post(
            `/api/v1/lab/labs/${lab}/entities/${entity.id}/program/stop`,
          )
        ).status(),
      ).toBe(200);
    }
    await expect
      .poll(
        async () =>
          (await world(agent, lab)).entities.filter(
            (entity) => entity.program_run?.status === 'running',
          ).length,
      )
      .toBe(0);
    const final = await world(agent, lab);
    const initialVersions = {
      member: await page.getByLabel('世界版本').textContent(),
      peer: await observer.getByLabel('世界版本').textContent(),
    };
    let convergence:
      | {
          serverVersion: string;
          memberVersion: string | null;
          peerVersion: string | null;
          running: number;
        }
      | undefined;
    try {
      await expect
        .poll(async () => {
          const current = await world(agent, lab);
          convergence = {
            serverVersion: current.version,
            memberVersion: await page.getByLabel('世界版本').textContent(),
            peerVersion: await observer.getByLabel('世界版本').textContent(),
            running: current.entities.filter(
              (entity) => entity.program_run?.status === 'running',
            ).length,
          };
          expect(current.lab.layout_version).toBe(final.lab.layout_version);
          expect(current.nodes).toEqual(final.nodes);
          expect(current.relationships).toEqual(final.relationships);
          return (
            convergence.running === 0 &&
            convergence.memberVersion === `W${convergence.serverVersion}` &&
            convergence.peerVersion === `W${convergence.serverVersion}`
          );
        })
        .toBe(true);
    } finally {
      writeFileSync(
        `${evidence}/final-world-comparison.json`,
        JSON.stringify(
          {
            event: 'foundation.final-world-comparison',
            expectedVersion: final.version,
            initialVersions,
            convergence,
            memberVersion: await page.getByLabel('世界版本').textContent(),
            peerVersion: await observer.getByLabel('世界版本').textContent(),
            runStates: final.entities.flatMap((entity) =>
              entity.program_run ? [entity.program_run.status] : [],
            ),
          },
          null,
          2,
        ),
      );
    }
    if (!desktopMigration)
      await observer.setViewportSize({ width: 320, height: 900 });
    await observer
      .getByRole('button', { name: 'English', exact: true })
      .click();
    await observer.getByRole('button', { name: 'Dark', exact: true }).click();
    await capture(
      observer,
      `complete-${desktopMigration ? 'desktop' : 'mobile'}-en-dark`,
    );
    expect(
      await observer.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await observer.getByText(/30.?x|120.?x|Scenario|场景注入/).count(),
    ).toBe(0);
    expect(errors).toEqual([]);
    writeFileSync(
      `${evidence}/journey.json`,
      JSON.stringify(
        {
          lab: lab,
          chapters: 9,
          entities: final.entities.length,
          nodes: final.nodes.length,
          worldVersion: final.version,
          testedRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          dirtyScope: execFileSync('git', ['status', '--short'], {
            encoding: 'utf8',
          }).trim(),
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await resourceTiming?.finish();
    await second?.close();
    await agent.dispose();
  }
});
