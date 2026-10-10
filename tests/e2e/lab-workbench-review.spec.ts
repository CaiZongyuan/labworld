import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { showEntityDetails, showObjectDirectory } from './lab-desktop';
import { labRepresentationProfiles } from '../../packages/contracts/src/lab-representations';
import type {
  LabLayout,
  LabWorld,
  Placement,
} from '../../packages/contracts/src/generated/types.gen';

const desktopMigration = process.env.LAB_WORD_MIGRATION_DESKTOP === 'true';

test.use({ locale: 'zh-CN' });
const evidence =
  process.env.LAB_WORKBENCH_EVIDENCE ?? '.scratch/workbench/review';
mkdirSync(evidence, { recursive: true });
test.afterEach(async ({ page }, info) => {
  const name = info.title.includes('camera') ? 'camera' : 'history';
  writeFileSync(
    join(evidence, `${name}-result.json`),
    JSON.stringify(
      {
        status: info.status,
        positions: info.errors.flatMap(
          (error) =>
            error.stack?.match(/lab-workbench-review\.spec\.ts:\d+:\d+/g) ?? [],
        ),
      },
      null,
      2,
    ),
  );
  if (
    info.status !== info.expectedStatus &&
    new URL(page.url()).pathname === '/lab'
  )
    await page.screenshot({ path: join(evidence, `${name}-failure.png`) });
});

async function member(page: Page) {
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`workbench-review-${crypto.randomUUID()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('workbench-browser-password');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page).toHaveURL(/\/lab$/);
  const identity = await (
    await page.request.get('/api/v1/auth/session')
  ).json();
  return {
    origin: process.env.E2E_WEB_URL!,
    'x-csrf-token': identity.csrf_token,
  };
}
async function register(
  page: Page,
  headers: Record<string, string>,
  lab: string,
  definition: string,
  name: string,
) {
  const response = await page.request.post(`/api/v1/lab/labs/${lab}/entities`, {
    headers,
    data: {
      definition_id: definition,
      definition_version: '1.0',
      name,
      reality: 'simulated',
      configuration: {},
      representation_id: null,
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function lab(page: Page, headers: Record<string, string>, name: string) {
  const response = await page.request.post('/api/v1/lab/labs', {
    headers,
    data: { name },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function bounds(page: Page, locator: Locator) {
  const rect = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 1);
  return rect;
}

function retainRobotEvidence(name: string, bytes: Buffer | string) {
  try {
    const directory = process.env.LAB_NODE_EVIDENCE ?? evidence;
    writeFileSync(join(directory, name), bytes);
  } catch {
    // Optional evidence must preserve the original public assertion result.
  }
}
let robotCapture = 0;

// The native teal pixels need the same-Entity controls in the owning case.
// No camera or scene internals are read.
async function robotPixels(
  page: Page,
  region?: { x: number; y: number; width: number; height: number },
) {
  const png = await page.locator('canvas').screenshot();
  const capture = `robot-frame-${String(++robotCapture).padStart(3, '0')}`;
  retainRobotEvidence(`${capture}.png`, png);
  const sampled = await page.evaluate(
    async ({ encoded, region }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < data.length; i += 4) {
        const x = (i / 4) % image.width,
          y = Math.floor(i / 4 / image.width);
        if (
          region &&
          (x < region.x ||
            x > region.x + region.width ||
            y < region.y ||
            y > region.y + region.height)
        )
          continue;
        if (
          data[i + 1] > data[i] * 1.2 &&
          data[i + 2] > data[i] * 1.2 &&
          data[i + 2] > 45
        )
          points.push({ x, y });
      }
      const xs = points.map((point) => point.x),
        ys = points.map((point) => point.y);
      return {
        count: points.length,
        x: points.length ? Math.min(...xs) : 0,
        y: points.length ? Math.min(...ys) : 0,
        width: points.length ? Math.max(...xs) - Math.min(...xs) : 0,
        height: points.length ? Math.max(...ys) - Math.min(...ys) : 0,
        landmark: points.length ? points[Math.floor(points.length / 2)] : null,
      };
    },
    { encoded: png.toString('base64'), region },
  );
  const { landmark, ...pixels } = sampled;
  retainRobotEvidence(
    `${capture}.json`,
    JSON.stringify({ region: region ?? null, pixels, landmark }),
  );
  return { png, pixels, landmark };
}
async function steadyRobot(page: Page) {
  let previous = (await robotPixels(page)).pixels;
  await expect
    .poll(
      async () => {
        const next = (await robotPixels(page)).pixels;
        const delta =
          Math.abs(next.x - previous.x) +
          Math.abs(next.y - previous.y) +
          Math.abs(next.width - previous.width) +
          Math.abs(next.height - previous.height);
        previous = next;
        return delta;
      },
      { timeout: 30000 },
    )
    .toBeLessThan(2);
  return robotPixels(page);
}

test('real World structural updates preserve an orbited camera until explicit Fit', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const headers = await member(page),
    worldLab = await lab(page, headers, 'Camera review Lab');
  const bench = await register(
    page,
    headers,
    worldLab.id,
    'bench',
    'Original bench',
  );
  const robot = await register(
    page,
    headers,
    worldLab.id,
    'robot',
    'Original Robot',
  );
  const otherContext = await browser.newContext({ locale: 'zh-CN' });
  try {
    const other = await otherContext.newPage(),
      otherHeaders = await member(other);
    await other.goto('/assets');
    await other
      .getByLabel('GLB 文件')
      .setInputFiles('tests/fixtures/lab/cube-draco.glb');
    await other
      .getByRole('dialog')
      .getByRole('button', { name: '发布资产' })
      .click();
    await expect(
      other.getByText('cube-draco.glb', { exact: true }),
    ).toBeVisible();
    const assets = await (await other.request.get('/api/v1/lab/assets')).json();
    const representation = assets.data.find(
      (asset: { name: string }) => asset.name === 'cube-draco',
    ).representation.id;
    await page.goto(`/lab?lab=${worldLab.id}`);
    await expect(page.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const worldPath = `/api/v1/lab/labs/${worldLab.id}/world`;
    const readWorld = async () => {
      const response = await page.request.get(worldPath);
      expect(response.status()).toBe(200);
      return (await response.json()) as LabWorld;
    };
    const savePlacement = async (
      operation: string,
      update: (node: LabWorld['nodes'][number]) => Placement,
    ) => {
      const before = await readWorld();
      expect(
        before.nodes.filter((node) => node.entity_id === robot.id),
      ).toHaveLength(1);
      const nodes = before.nodes.map((node) => ({
        id: node.id,
        entity_id: node.entity_id,
        representation_id: node.representation_id,
        placement: update(node),
      }));
      const response = await page.request.put(
        `/api/v1/lab/labs/${worldLab.id}/layout`,
        {
          headers,
          data: { expected_version: before.lab.layout_version, nodes },
        },
      );
      expect(response.status()).toBe(200);
      const saved = (await response.json()) as LabLayout;
      expect(saved.layout_version).toBe(before.lab.layout_version + 1);
      const after = await readWorld();
      expect(after.lab.layout_version).toBe(saved.layout_version);
      expect(after.nodes).toHaveLength(nodes.length);
      expect(after.nodes).toEqual(
        expect.arrayContaining(
          nodes.map((node) => expect.objectContaining(node)),
        ),
      );
      expect(after.relationships).toEqual(before.relationships);
      const previousRobot = before.entities.find(
        (entity) => entity.id === robot.id,
      )!;
      const currentRobot = after.entities.find(
        (entity) => entity.id === robot.id,
      )!;
      expect(previousRobot).toBeDefined();
      expect(currentRobot).toBeDefined();
      expect(currentRobot.id).toBe(previousRobot.id);
      expect(currentRobot.representation_id).toBe(
        previousRobot.representation_id,
      );
      expect(currentRobot.binding?.id).toBe(previousRobot.binding?.id);
      expect(currentRobot.program_run?.id).toBe(previousRobot.program_run?.id);
      retainRobotEvidence(
        `robot-${operation}-layout.json`,
        JSON.stringify({
          beforeVersion: before.lab.layout_version,
          afterVersion: after.lab.layout_version,
          nodes,
          relationships: after.relationships,
          robot: {
            id: currentRobot.id,
            representationId: currentRobot.representation_id,
            bindingId: currentRobot.binding?.id ?? null,
            runId: currentRobot.program_run?.id ?? null,
          },
        }),
      );
      await expect(
        page
          .locator('.lab-heading')
          .getByText(`v${saved.layout_version}`, { exact: true }),
      ).toBeVisible();
      await expect(page.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      return after;
    };
    const separation =
      labRepresentationProfiles.profiles.bench.bounds.max[0] -
      labRepresentationProfiles.profiles.robot.bounds.min[0] +
      labRepresentationProfiles.profiles.bench.bounds.size[0];
    const prepared = await savePlacement('separated-fixture', (node) => {
      const x =
        node.entity_id === bench.id
          ? 0
          : node.entity_id === robot.id
            ? separation
            : null;
      if (x !== null) {
        expect(node.representation_id).toBeNull();
        expect(node.placement.scale).toEqual([1, 1, 1]);
      }
      return x === null
        ? node.placement
        : {
            ...node.placement,
            position: [
              x,
              node.placement.position[1],
              node.placement.position[2],
            ],
          };
    });
    const robotNodes = prepared.nodes.filter(
      (node) => node.entity_id === robot.id,
    );
    expect(robotNodes).toHaveLength(1);
    const robotNode = robotNodes[0];
    expect(robotNode.representation_id).toBeNull();
    const originalPlacement = structuredClone(robotNode.placement);
    const placeRobot = (operation: string, position: Placement['position']) =>
      savePlacement(operation, (node) => {
        if (node.entity_id !== robot.id) return node.placement;
        expect(node.id).toBe(robotNode.id);
        expect(node.entity_id).toBe(robot.id);
        expect(node.representation_id).toBe(robotNode.representation_id);
        return { ...node.placement, position: [...position] };
      });
    const selectedEntityId = async () => {
      const details = await showEntityDetails(page);
      return details
        .locator('dt')
        .filter({ hasText: /^Entity$/ })
        .locator('+ dd')
        .innerText();
    };
    const selectRobot = async () => {
      await showObjectDirectory(page);
      await page
        .getByRole('button', { name: '选择 Original Robot', exact: true })
        .click();
      expect(await selectedEntityId()).toBe(robot.id);
      await page
        .getByRole('button', { name: '关闭对象目录', exact: true })
        .click();
      await page
        .getByRole('button', { name: '关闭对象信息', exact: true })
        .click();
    };
    await selectRobot();
    await page
      .locator('.world-priority-label')
      .getByRole('button', { name: '定位 Original Robot', exact: true })
      .click();
    await selectRobot();
    const initial = await steadyRobot(page);
    expect(initial.pixels.count).toBeGreaterThan(100);
    const canvas = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(
      canvas.x + canvas.width * 0.8,
      canvas.y + canvas.height * 0.35,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvas.x + canvas.width * 0.8 - 100,
      canvas.y + canvas.height * 0.35 + 50,
      { steps: 20 },
    );
    await page.mouse.up();
    const orbited = await steadyRobot(page);
    expect(
      Math.abs(orbited.pixels.x - initial.pixels.x) +
        Math.abs(orbited.pixels.y - initial.pixels.y),
    ).toBeGreaterThan(10);
    const region = {
      x: orbited.pixels.x - 15,
      y: orbited.pixels.y - 15,
      width: orbited.pixels.width + 30,
      height: orbited.pixels.height + 30,
    };
    const measurements: unknown[] = [
      { operation: 'orbit', pixels: orbited.pixels },
    ];
    const verify = async (operation: string) => {
      await expect(page.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await selectRobot();
      await expect
        .poll(() => page.locator('canvas').boundingBox())
        .toEqual(canvas);
      const current = await robotPixels(page, region);
      expect(current.png.readUInt32BE(16)).toBe(orbited.png.readUInt32BE(16));
      expect(current.png.readUInt32BE(20)).toBe(orbited.png.readUInt32BE(20));
      measurements.push({ operation, pixels: current.pixels });
      retainRobotEvidence(
        'camera-landmarks.json',
        JSON.stringify(measurements, null, 2),
      );
      retainRobotEvidence(`camera-${operation}.png`, current.png);
      expect(current.pixels.count).toBeGreaterThan(orbited.pixels.count * 0.7);
      expect(Math.abs(current.pixels.x - orbited.pixels.x)).toBeLessThan(3);
      expect(Math.abs(current.pixels.y - orbited.pixels.y)).toBeLessThan(3);
      expect(
        Math.abs(current.pixels.width - orbited.pixels.width),
      ).toBeLessThan(3);
      expect(
        Math.abs(current.pixels.height - orbited.pixels.height),
      ).toBeLessThan(3);
      return current;
    };
    retainRobotEvidence('camera-orbited.png', orbited.png);
    await showObjectDirectory(page);
    await page
      .getByRole('button', { name: '选择 Original bench', exact: true })
      .click();
    const wrongTarget = await selectedEntityId();
    expect(wrongTarget).toBe(bench.id);
    expect(wrongTarget === robot.id).toBe(false);
    retainRobotEvidence(
      'robot-wrong-target.json',
      JSON.stringify({
        robotId: robot.id,
        selectedEntityId: wrongTarget,
        rejected: true,
      }),
    );
    await selectRobot();
    await showObjectDirectory(page);
    await page
      .getByRole('checkbox', { name: '多选 Original Robot', exact: true })
      .uncheck();
    await expect(
      page.getByRole('button', { name: '选择 Original Robot', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await page
      .getByRole('button', { name: '关闭对象目录', exact: true })
      .click();
    await steadyRobot(page);
    const unselected = await robotPixels(page, region);
    expect(unselected.landmark).not.toBeNull();
    const hitCanvas = (await page.locator('canvas').boundingBox())!;
    expect(hitCanvas).toEqual(canvas);
    expect(unselected.png.readUInt32BE(16)).toBe(orbited.png.readUInt32BE(16));
    expect(unselected.png.readUInt32BE(20)).toBe(orbited.png.readUInt32BE(20));
    const point = {
      x:
        hitCanvas.x +
        ((unselected.landmark!.x + 0.5) * hitCanvas.width) /
          unselected.png.readUInt32BE(16),
      y:
        hitCanvas.y +
        ((unselected.landmark!.y + 0.5) * hitCanvas.height) /
          unselected.png.readUInt32BE(20),
    };
    await expect
      .poll(() =>
        page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
          point,
        ),
      )
      .toBe('CANVAS');
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('entity'))
      .toBe(robot.id);
    expect(await selectedEntityId()).toBe(robot.id);
    retainRobotEvidence(
      'robot-native-hit.json',
      JSON.stringify({
        robotId: robot.id,
        priorSelectionEmpty: true,
        point,
        imagePoint: unselected.landmark,
        pointTarget: 'CANVAS',
        selectedEntityId: robot.id,
        nodeId: robotNode.id,
        region,
      }),
    );
    await verify('identity-restored');
    await placeRobot('moved-outside-fixed-region', [
      100,
      originalPlacement.position[1],
      originalPlacement.position[2],
    ]);
    await selectRobot();
    await expect
      .poll(() => page.locator('canvas').boundingBox())
      .toEqual(canvas);
    const excluded = await robotPixels(page, region);
    retainRobotEvidence(
      'robot-fixed-region-excluded.json',
      JSON.stringify({ region, pixels: excluded.pixels }),
    );
    expect(excluded.png.readUInt32BE(16)).toBe(orbited.png.readUInt32BE(16));
    expect(excluded.png.readUInt32BE(20)).toBe(orbited.png.readUInt32BE(20));
    expect(excluded.pixels.count).toBe(0);
    const restored = await placeRobot(
      'restored-original-placement',
      originalPlacement.position,
    );
    expect(
      restored.nodes.find((node) => node.id === robotNode.id),
    ).toMatchObject({
      id: robotNode.id,
      entity_id: robot.id,
      representation_id: robotNode.representation_id,
      placement: originalPlacement,
    });
    const restoredPixels = await verify('restored-original-placement');
    expect(restoredPixels.pixels.count).toBeGreaterThan(100);
    const before = await (
      await other.request.get(`/api/v1/lab/labs/${worldLab.id}/world`)
    ).json();
    const copied = await other.request.post(
      `/api/v1/lab/labs/${worldLab.id}/entities/${bench.id}/copies`,
      {
        headers: otherHeaders,
        data: {
          expected_version: before.lab.layout_version,
          name: 'Remote far bench',
          placement: {
            position: [15, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      },
    );
    expect(copied.status()).toBe(201);
    const remote = await copied.json();
    await page.getByRole('button', { name: '打开对象目录' }).click();
    await expect(
      page.getByRole('button', { name: '选择 Remote far bench', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '关闭对象目录' }).click();
    await verify('added-node');
    expect(
      (
        await other.request.post(
          `/api/v1/lab/labs/${worldLab.id}/entities/${remote.id}/archive`,
          { headers: otherHeaders },
        )
      ).status(),
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/v1/lab/labs/${worldLab.id}/world`)
            ).json()
          ).entities.find((entity: { id: string }) => entity.id === remote.id)
            .archived_at,
      )
      .toBeTruthy();
    await page.getByRole('button', { name: '打开对象目录' }).click();
    await expect(
      page.getByRole('button', { name: '选择 Remote far bench', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: '关闭对象目录' }).click();
    await verify('archived-node');
    const loadedGlb = page.waitForResponse(async (response) => {
      const url = new URL(response.url());
      if (
        response.request().resourceType() !== 'fetch' ||
        url.origin !== new URL(process.env.E2E_WEB_URL!).origin ||
        !url.pathname.startsWith('/objects/')
      )
        return false;
      const bytes = await response.body();
      return bytes.subarray(0, 4).toString() === 'glTF';
    });
    const changed = await other.request.put(
      `/api/v1/lab/labs/${worldLab.id}/entities/${bench.id}/appearance`,
      { headers: otherHeaders, data: { representation_id: representation } },
    );
    expect(changed.status()).toBe(200);
    await page.getByRole('button', { name: '打开对象目录' }).click();
    await page
      .getByRole('button', { name: '选择 Original bench', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', { name: '对象信息' }),
    ).toContainText(representation);
    await page.getByRole('button', { name: '关闭对象目录' }).click();
    await page.getByRole('button', { name: '关闭对象信息' }).click();
    await loadedGlb;
    await verify('appearance-loaded');
    await page.getByRole('button', { name: '聚焦模型', exact: true }).click();
    const fitted = await steadyRobot(page);
    expect(
      Math.abs(fitted.pixels.x - orbited.pixels.x) +
        Math.abs(fitted.pixels.y - orbited.pixels.y),
    ).toBeGreaterThan(10);
    const nextLab = await lab(
      other,
      otherHeaders,
      'First frame in another Lab',
    );
    await register(other, otherHeaders, nextLab.id, 'robot', 'Other Lab Robot');
    await page.goto(`/lab?lab=${nextLab.id}`);
    expect((await steadyRobot(page)).pixels.count).toBeGreaterThan(100);
  } finally {
    await otherContext.close();
  }
});

test('narrow history keeps filters, real command records and pagination reachable and returns to its Entity', async ({
  page,
}) => {
  test.skip(
    desktopMigration,
    'Product narrow-screen coverage resumes after Migration Gate',
  );
  test.setTimeout(180000);
  const headers = await member(page),
    worldLab = await lab(page, headers, 'History review Lab');
  const lamp = await register(
    page,
    headers,
    worldLab.id,
    'light',
    'History lamp',
  );
  const path = `/api/v1/lab/labs/${worldLab.id}/entities/${lamp.id}`;
  expect(
    (await page.request.post(`${path}/program/start`, { headers })).status(),
  ).toBe(201);
  for (let i = 0; i < 25; i++) {
    const command = await page.request.post(`${path}/actions`, {
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      data: { capability: 'light.set_power', parameters: { on: i % 2 === 0 } },
    });
    expect(command.status()).toBe(202);
  }
  const measurements: unknown[] = [];
  for (const [width, english] of [
    [390, false],
    [320, true],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/lab?lab=${worldLab.id}&entity=${lamp.id}`);
    await expect(
      page.getByRole('complementary', { name: '对象信息' }),
    ).toBeVisible();
    if (english) {
      await page.getByRole('button', { name: 'English' }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
    }
    const directory = page.getByRole('button', {
      name: english ? 'Open object directory' : '打开对象目录',
    });
    await directory.click();
    const inspector = page.getByRole('button', {
      name: english ? 'Open object details' : '打开对象信息',
    });
    await expect(inspector).toHaveAttribute('aria-expanded', 'false');
    await inspector.click();
    await expect(
      page.getByRole('complementary', {
        name: english ? 'Object directory' : '对象目录',
      }),
    ).toBeHidden();
    await expect(inspector).toHaveAttribute('aria-expanded', 'true');
    const trigger = page.getByRole('button', {
      name: english ? 'Open run history' : '打开运行历史',
    });
    await trigger.click();
    const surface = page.locator('.world-history-surface');
    const history = page.getByRole('region', {
      name: english ? 'Lab records' : '运行记录',
    });
    const panelRect = await bounds(page, surface);
    await history
      .getByLabel(english ? 'Record category' : '记录类别')
      .selectOption('command');
    const query = history.getByRole('button', {
      name: english ? 'Query records' : '查询记录',
      exact: true,
    });
    const from = history.getByLabel(english ? 'From' : '开始时间', {
      exact: true,
    });
    await from.scrollIntoViewIfNeeded();
    await from.fill(`${(await from.inputValue()).slice(0, 10)}T00:00`);
    await query.scrollIntoViewIfNeeded();
    await bounds(page, query);
    await query.click();
    await expect(history.locator('.lab-records > ol > li')).toHaveCount(20);
    const more = history.getByRole('button', {
      name: english ? 'Earlier Lab records' : '更早运行记录',
      exact: true,
    });
    await more.scrollIntoViewIfNeeded();
    const moreRect = await bounds(page, more);
    await more.click();
    await expect(history.locator('.lab-records > ol > li')).toHaveCount(5);
    const scroll = await surface.evaluate((element) => ({
      top: element.scrollTop,
      height: element.clientHeight,
      total: element.scrollHeight,
      overflow: getComputedStyle(element).overflowY,
    }));
    expect(scroll.total).toBeGreaterThan(scroll.height);
    expect(scroll.top).toBeGreaterThan(0);
    expect(['auto', 'scroll']).toContain(scroll.overflow);
    await page.screenshot({
      path: join(evidence, `history-${width}-pagination.png`),
    });
    await surface
      .getByRole('button', {
        name: english ? 'Close run history' : '关闭运行历史',
        exact: true,
      })
      .click();
    await expect(trigger).toBeFocused();
    await expect(
      page.getByRole('complementary', {
        name: english ? 'Object info' : '对象信息',
      }),
    ).toContainText(lamp.id);
    measurements.push({ width, panelRect, moreRect, scroll });
  }
  writeFileSync(
    join(evidence, 'history-rectangles.json'),
    JSON.stringify(measurements, null, 2),
  );
  expect(
    (await page.request.post(`${path}/program/stop`, { headers })).status(),
  ).toBe(200);
});
