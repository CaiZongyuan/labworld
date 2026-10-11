import { expect, test, type Page } from '@playwright/test';
import {
  showEntityOperations,
  showObjectDirectory,
} from '../../tests/e2e/lab-desktop';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeRasterPhases } from './lab-raster-phases';
import { cameraObserver } from './observer';
type Observer = ReturnType<typeof cameraObserver>;
const observers = new WeakMap<Page, Observer>();
let activeObserver: Observer | undefined;

test.use({ locale: 'zh-CN', colorScheme: 'light' });

const rasterObservers = new WeakMap<
  Page,
  ReturnType<typeof observeRasterPhases>
>();
type RasterReceipt = {
  width: number;
  height: number;
  changedPixels: number | null;
};
type RasterEvidence = {
  fullCaptureAttempts: number;
  latestCapture?: {
    attempt: number;
    png: Buffer;
    clip: { x: number; y: number; width: number; height: number };
  };
  lastComparedPair?: { before: Buffer; after: Buffer; receipt: RasterReceipt };
  comparisons: RasterReceipt[];
};
const rasterEvidence = new WeakMap<Page, RasterEvidence>();
test.beforeEach(async ({ page }) => {
  const observer = cameraObserver(page);
  observers.set(page, observer);
  activeObserver = observer;
  await observer.setup();
  rasterObservers.set(
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
  if (process.env.LAB_NODE_EVIDENCE)
    rasterEvidence.set(page, { fullCaptureAttempts: 0, comparisons: [] });
});
test.afterEach(({ page }) => {
  const evidence = rasterEvidence.get(page);
  const directory = process.env.LAB_NODE_EVIDENCE;
  if (!evidence || !directory) return;
  const latestCapture = evidence.latestCapture;
  const lastComparedPair = evidence.lastComparedPair;
  try {
    if (latestCapture)
      activeObserver!.measureWrite('raster-retention', () =>
        writeFileSync(
          join(directory, 'spatial-latest-completed-full-capture.png'),
          latestCapture.png,
        ),
      );
    if (lastComparedPair) {
      activeObserver!.measureWrite('raster-retention', () =>
        writeFileSync(
          join(directory, 'spatial-last-compared-before.png'),
          lastComparedPair.before,
        ),
      );
      activeObserver!.measureWrite('raster-retention', () =>
        writeFileSync(
          join(directory, 'spatial-last-compared-after.png'),
          lastComparedPair.after,
        ),
      );
    }
    activeObserver!.measureWrite('raster-retention', () =>
      writeFileSync(
        join(directory, 'spatial-raster-receipt.json'),
        JSON.stringify({
          fullCaptureAttempts: evidence.fullCaptureAttempts,
          latestCompletedFullCapture: latestCapture
            ? {
                attempt: latestCapture.attempt,
                clip: latestCapture.clip,
              }
            : null,
          // This pair may precede a failed capture that never reached comparison.
          lastEnteredComparison: lastComparedPair?.receipt ?? null,
          comparisons: evidence.comparisons,
        }) + '\n',
      ),
    );
  } catch {
    // Optional retention outside the acceptance clock preserves the primary result.
  } finally {
    rasterEvidence.delete(page);
    rasterObservers.delete(page);
  }
});

async function registerObject(page: Page, name: string, kind = 'sensor') {
  await observers
    .get(page)!
    .operation('registerObject.L78', 78, async () =>
      page.getByRole('button', { name: '登记对象', exact: true }).click(),
    );
  const dialog = page.getByRole('dialog');
  await observers
    .get(page)!
    .operation('registerObject.L80', 80, async () =>
      dialog.getByLabel('定义版本').selectOption(`${kind}@1.0`),
    );
  await observers
    .get(page)!
    .operation('registerObject.L81', 81, async () =>
      dialog.getByLabel('名称', { exact: true }).fill(name),
    );
  await observers
    .get(page)!
    .operation('registerObject.L82', 82, async () =>
      dialog.getByRole('button', { name: '登记', exact: true }).click(),
    );
  await observers
    .get(page)!
    .operation('registerObject.L83', 83, async () =>
      expect(dialog).toBeHidden(),
    );
  await observers
    .get(page)!
    .operation('registerObject.L84', 84, async () =>
      expect(page.getByRole('heading', { name, exact: true })).toBeVisible(),
    );
}

async function selectSensor(page: Page, name: string) {
  await observers
    .get(page)!
    .operation('selectSensor.L88', 88, async () => showObjectDirectory(page));
  await observers
    .get(page)!
    .operation('selectSensor.L89', 89, async () =>
      page.getByRole('button', { name: `选择 ${name}`, exact: true }).click(),
    );
  await observers
    .get(page)!
    .operation('selectSensor.L90', 90, async () => showEntityOperations(page));
}

async function staticCanvasRegion(page: Page) {
  const canvas = await page.locator('.world-viewport canvas').boundingBox();
  expect(canvas).not.toBeNull();
  // The selected sensor's lower body and grid are below its changing reading.
  return rasterObservers.get(page)!('region-screenshot', () =>
    page.screenshot({
      clip: {
        x: canvas!.x,
        y: canvas!.y + canvas!.height * 0.55,
        width: canvas!.width,
        height: canvas!.height * 0.45,
      },
    }),
  );
}

async function cameraSceneFrame(page: Page) {
  const evidence = rasterEvidence.get(page);
  const attempt = evidence ? ++evidence.fullCaptureAttempts : 0;
  observers.get(page)!.rasterNote('capture-entry', { captureOrdinal: attempt });
  const area = await rasterObservers.get(page)!('canvas-geometry', () =>
    page.locator('.world-viewport canvas').evaluate((canvas, identity) => {
      const begin = performance.now();
      const mark = (stage: string) =>
        (
          window as unknown as {
            __pm67PrefixState?: { rasterMark: (v: unknown) => void };
          }
        ).__pm67PrefixState?.rasterMark({
          ...identity,
          kind: 'geometry',
          stage,
          elapsedMs: performance.now() - begin,
        });
      mark('entry');
      try {
        const rect = canvas.getBoundingClientRect();
        const result = {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        };
        mark('end');
        return result;
      } catch (error) {
        mark('error');
        throw error;
      }
    }, observers.get(page)!.rasterIdentity(attempt)),
  );
  // Element capture additionally waits for stable animation frames and scrolls.
  // Capture the entire current canvas after guarding against page-clip trimming.
  const clip = {
    x: Math.floor(area.x),
    y: Math.floor(area.y),
    width: Math.ceil(area.right) - Math.floor(area.x),
    height: Math.ceil(area.bottom) - Math.floor(area.y),
  };
  expect(clip.x).toBeGreaterThanOrEqual(0);
  expect(clip.y).toBeGreaterThanOrEqual(0);
  expect(clip.width).toBeGreaterThan(0);
  expect(clip.height).toBeGreaterThan(0);
  expect(clip.x + clip.width).toBeLessThanOrEqual(area.viewportWidth);
  expect(clip.y + clip.height).toBeLessThanOrEqual(area.viewportHeight);
  const png = await rasterObservers.get(page)!('canvas-screenshot', () =>
    page.screenshot({
      clip,
      style:
        '.world-priority-label,.world-priority-labels,.world-canvas-tools,.world-transform-tools { visibility: hidden !important; }',
    }),
  );
  if (evidence) evidence.latestCapture = { attempt, png, clip };
  observers
    .get(page)!
    .rasterNote('capture-complete', { captureOrdinal: attempt });
  expect(png.readUInt32BE(16)).toBe(clip.width);
  expect(png.readUInt32BE(20)).toBe(clip.height);
  return png;
}

function saveRasterEvidence(
  name: string,
  before: Buffer,
  after: Buffer,
  changedPixels: number,
) {
  if (!process.env.LAB_NODE_EVIDENCE) return;
  try {
    const directory = process.env.LAB_NODE_EVIDENCE;
    activeObserver!.measureWrite('raster-retention', () =>
      writeFileSync(join(directory, `${name}-before.png`), before),
    );
    activeObserver!.measureWrite('raster-retention', () =>
      writeFileSync(join(directory, `${name}-after.png`), after),
    );
    activeObserver!.measureWrite('raster-retention', () =>
      writeFileSync(
        join(directory, `${name}-pixels.json`),
        JSON.stringify({ changedPixels }),
      ),
    );
  } catch {
    // Optional raster evidence does not replace the public pixel assertion.
  }
}

async function changedRegionPixels(page: Page, before: Buffer, after: Buffer) {
  const evidence = rasterEvidence.get(page);
  const receipt: RasterReceipt = {
    width: before.readUInt32BE(16),
    height: before.readUInt32BE(20),
    changedPixels: null,
  };
  if (evidence) {
    evidence.lastComparedPair = { before, after, receipt };
    if (evidence.comparisons.length < 256) evidence.comparisons.push(receipt);
  }
  expect(after.readUInt32BE(16)).toBe(before.readUInt32BE(16));
  expect(after.readUInt32BE(20)).toBe(before.readUInt32BE(20));
  // Identical screenshot PNG bytes imply zero changed RGB pixels.
  observers.get(page)!.rasterNote('comparison-entry');
  if (before.equals(after)) {
    observers
      .get(page)!
      .rasterNote('byte-equality-fastpath', { changedPixels: 0 });
    receipt.changedPixels = 0;
    return 0;
  }
  const changedPixels = await rasterObservers.get(page)!('pixel-evaluate', () =>
    page.evaluate(
      async (encoded) => {
        const begin = performance.now();
        const mark = (stage: string, changedPixels?: number) =>
          (
            window as unknown as {
              __pm67PrefixState?: { rasterMark: (v: unknown) => void };
            }
          ).__pm67PrefixState?.rasterMark({
            kind: 'pixel',
            stage,
            elapsedMs: performance.now() - begin,
            changedPixels,
          });
        mark('entry');
        try {
          const frames = await Promise.all(
            encoded.map(async (value) => {
              const image = new Image();
              image.src = `data:image/png;base64,${value}`;
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext('2d')!;
              context.drawImage(image, 0, 0);
              return context.getImageData(0, 0, canvas.width, canvas.height)
                .data;
            }),
          );
          mark('decodes-complete');
          let changed = 0;
          for (let i = 0; i < frames[0].length; i += 4)
            if (
              Math.abs(frames[0][i] - frames[1][i]) +
                Math.abs(frames[0][i + 1] - frames[1][i + 1]) +
                Math.abs(frames[0][i + 2] - frames[1][i + 2]) >
              30
            )
              changed++;
          mark('count-complete', changed);
          return changed;
        } catch (error) {
          mark('error');
          throw error;
        }
      },
      [before.toString('base64'), after.toString('base64')],
    ),
  );
  receipt.changedPixels = changedPixels;
  observers.get(page)!.rasterNote('comparison-complete', { changedPixels });
  return changedPixels;
}

async function pickCentredEntity(page: Page, name: string, entityId: string) {
  await observers
    .get(page)!
    .operation('pickCentredEntity.L225', 225, async () =>
      page
        .getByRole('checkbox', { name: `多选 ${name}`, exact: true })
        .uncheck(),
    );
  await observers
    .get(page)!
    .operation('pickCentredEntity.L228', 228, async () =>
      expect(
        page.getByRole('button', { name: `选择 ${name}`, exact: true }),
      ).toHaveAttribute('aria-pressed', 'false'),
    );
  await observers
    .get(page)!
    .operation('pickCentredEntity.L231', 231, async () =>
      expect
        .poll(async () => {
          observers.get(page)!.beginCallback('settled');
          return changedRegionPixels(
            page,
            await cameraSceneFrame(page),
            await cameraSceneFrame(page),
          );
        })
        .toBe(0),
    );
  // Accepted boundary: stop after the original whole settled-scene poll.
}

test('explicit location frames the selected object while selection and real observations preserve the camera', async ({
  page,
}) => {
  const observer = observers.get(page)!;
  let verdict: 'error' | 'settled-poll' = 'error';
  try {
    test.setTimeout(90000);
    await observer.operation('camera.L285', 285, async () =>
      page.setViewportSize({ width: 1440, height: 1000 }),
    );
    await observer.operation('camera.L286', 286, async () =>
      page.goto('/register'),
    );
    await observer.operation('camera.L287', 287, async () =>
      page
        .getByLabel('邮箱', { exact: true })
        .fill(`spatial-camera-${Date.now()}@example.test`),
    );
    await observer.operation('camera.L290', 290, async () =>
      page
        .getByLabel('密码', { exact: true })
        .fill('spatial-camera-fixture-password'),
    );
    await observer.operation('camera.L293', 293, async () =>
      page.getByRole('button', { name: '创建账号', exact: true }).click(),
    );
    await observer.operation('camera.L294', 294, async () =>
      expect(page).toHaveURL(/\/lab$/),
    );
    await observer.operation('camera.L295', 295, async () =>
      page.getByRole('button', { name: '创建 Lab', exact: true }).click(),
    );
    const dialog = page.getByRole('dialog');
    await observer.operation('camera.L297', 297, async () =>
      dialog
        .getByLabel('名称', { exact: true })
        .fill('Camera location fixture'),
    );
    await observer.operation('camera.L300', 300, async () =>
      dialog.getByRole('button', { name: '创建', exact: true }).click(),
    );
    await observer.operation('camera.L301', 301, async () =>
      expect(dialog).toBeHidden(),
    );
    await observer.operation('camera.L302', 302, async () =>
      registerObject(page, 'Camera Sensor A'),
    );
    await observer.operation('camera.L303', 303, async () =>
      registerObject(page, 'Camera Sensor B'),
    );
    await observer.operation('camera.L304', 304, async () =>
      registerObject(page, 'Asymmetric camera landmark', 'bench'),
    );
    const lab = new URL(page.url()).searchParams.get('lab');
    expect(lab).toBeTruthy();
    const session = await observer.operation('camera.L307', 307, async () =>
      (await page.request.get('/api/v1/auth/session')).json(),
    );
    const before = await observer.operation('camera.L308', 308, async () =>
      (await page.request.get(`/api/v1/lab/labs/${lab}/world`)).json(),
    );
    const sensorA = before.entities.find(
      (entity: { name: string }) => entity.name === 'Camera Sensor A',
    );
    const sensorB = before.entities.find(
      (entity: { name: string }) => entity.name === 'Camera Sensor B',
    );
    expect(sensorA).toBeTruthy();
    expect(sensorB).toBeTruthy();
    const entityNames = new Map(
      before.entities.map((entity: { id: string; name: string }) => [
        entity.id,
        entity.name,
      ]),
    );
    const placement = await observer.operation('camera.L325', 325, async () =>
      page.request.put(`/api/v1/lab/labs/${lab}/layout`, {
        headers: {
          origin: process.env.E2E_WEB_URL!,
          'x-csrf-token': session.csrf_token,
        },
        data: {
          expected_version: before.lab.layout_version,
          nodes: before.nodes.map(
            (node: {
              id: string;
              entity_id: string;
              representation_id: string | null;
              placement: unknown;
            }) => ({
              id: node.id,
              entity_id: node.entity_id,
              representation_id: node.representation_id,
              placement: {
                position:
                  entityNames.get(node.entity_id) === 'Camera Sensor A'
                    ? [-2.4, 0.96, 1.8]
                    : entityNames.get(node.entity_id) === 'Camera Sensor B'
                      ? [2.4, 0.96, -1.8]
                      : [-2.65, 1.15, 1.47],
                rotation:
                  entityNames.get(node.entity_id) ===
                  'Asymmetric camera landmark'
                    ? [0, 0.35, 0]
                    : [0, 0, 0],
                scale:
                  entityNames.get(node.entity_id) ===
                  'Asymmetric camera landmark'
                    ? [0.2, 0.2, 0.2]
                    : [1, 1, 1],
              },
            }),
          ),
          relationships: [],
        },
      }),
    );
    expect(placement.status()).toBe(200);
    await observer.operation('camera.L364', 364, async () => page.reload());
    await observer.operation('camera.L365', 365, async () =>
      expect(page.locator('.world-page')).toHaveAttribute('aria-busy', 'false'),
    );
    await observer.clock();
    await observer.operation('camera.L369', 369, async () =>
      selectSensor(page, 'Camera Sensor A'),
    );
    const beforeFocusA = await observer.operation(
      'camera.L370',
      370,
      async () => cameraSceneFrame(page),
    );
    await observer.operation('camera.L371', 371, async () =>
      page.getByRole('button', { name: '聚焦模型', exact: true }).click(),
    );
    await observer.operation('camera.L372', 372, async () =>
      expect
        .poll(async () => {
          observer.beginCallback('explicit-focus');
          const after = await cameraSceneFrame(page);
          const changed = await changedRegionPixels(page, beforeFocusA, after);
          saveRasterEvidence('explicit-focus-a', beforeFocusA, after, changed);
          return changed;
        })
        .toBeGreaterThan(30),
    );
    await observer.operation('camera.L380', 380, async () =>
      pickCentredEntity(page, 'Camera Sensor A', sensorA.id),
    );
    // Accepted prefix stops before boundingBox/hit/pick and all later work.

    verdict = 'settled-poll';
  } finally {
    await observer.finish(verdict);
  }
});
