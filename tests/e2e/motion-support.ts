import { expectInitialSceneReady } from './initial-scene-ready';
import {
  expect,
  type Page,
  type Browser,
  type BrowserContext,
} from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { connect as tcpConnect } from 'node:net';
import { WebSocket } from 'ws';
import { CoreHttp } from '../support/core-http';
import { publishAsset } from '../support/lab-assets-http';
import { displayed, rawHeader, type Diagnostic } from './motion-oracle';
import { launchMotionActor } from '../support/motion-actor';
import type { MotionSocketFact } from '../support/motion-socket';

type Fixture = {
  lab_id: string;
  session_id: string;
  scene_hash: string;
  mapping_revision: number;
  targets: { node_id: string; entity_id: string }[];
};
type Ticket = { ticket: string; websocket_path: string };
type Ledger = {
  data: { runId: string; owner: string; closing?: boolean };
  save(): void;
  snapshot(stage: string): void;
  planConsumer(role: string): { id: string; marker: string };
  launchedConsumer(id: string, pid: number): void;
  stop(pid: number): Promise<void>;
  reconcile(stage: string): void;
};
type ProcessRun = { child: ChildProcess; stdout: string; stderr: string };
export const rootEvidence =
  process.env.MOTION_E2E_OUTPUT ??
  process.env.LAB_NODE_EVIDENCE ??
  'test-results';
export function receipt(name: string, value: unknown) {
  mkdirSync(rootEvidence, { recursive: true });
  writeFileSync(
    join(rootEvidence, name + '.json'),
    JSON.stringify(value, null, 2) + '\n',
    { mode: 0o600 },
  );
}
export function stage(stage: string, detail: Record<string, unknown> = {}) {
  mkdirSync(rootEvidence, { recursive: true });
  appendFileSync(
    join(rootEvidence, 'e2e-journal.jsonl'),
    JSON.stringify({ stage, at: new Date().toISOString(), ...detail }) + '\n',
    { mode: 0o600 },
  );
}
export async function eventually<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const deadline = performance.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (accepted(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  } while (performance.now() < deadline);
  throw new Error('Motion public condition did not become ready');
}
export function observer() {
  const pid = readFileSync(process.env.E2E_API_PID_FILE!, 'utf8').trim();
  return JSON.parse(
    readFileSync(
      join(process.env.MOTION_E2E_OBSERVER_DIR!, pid + '.json'),
      'utf8',
    ),
  ) as {
    frames: number;
    directPoseDbCalls: number;
    pendingMaxBytes: number;
    pendingMaxSlots: number;
    liveSockets: number;
    rssBytes: number;
    observerMs: number;
    sockets: MotionSocketFact[];
  };
}
export class Actors {
  private constructor(private ledger: Ledger) {}
  private runs: ProcessRun[] = [];
  static async create(name: string) {
    const module = await import(
      new URL('../../scripts/lib/contract-resources.mjs', import.meta.url).href
    );
    const ledger: Ledger = new module.ContractResources(
      join(process.env.LAB_NODE_EVIDENCE!, `${name}-owned-resources.json`),
      randomUUID(),
      false,
    );
    ledger.data.owner =
      'Independent issue 70 E2E Publisher and slow TCP reader';
    ledger.save();
    ledger.snapshot('start');
    return new Actors(ledger);
  }
  start(script: string, args: string[], ticket: string) {
    const intent = this.ledger.planConsumer(
      'motion-python-' + script.split('/').at(-1),
    );
    const child = launchMotionActor(
      process.env.MOTION_E2E_PYTHON!,
      script,
      args,
      {
        ...process.env,
        CONTRACT_RUN_ID: this.ledger.data.runId,
        CONTRACT_CONSUMER_MARKER: intent.marker,
      },
    );
    if (!child.pid) throw new Error('Owned Python process did not launch');
    this.ledger.launchedConsumer(intent.id, child.pid);
    const run = { child, stdout: '', stderr: '' };
    child.stdout!.on('data', (data) => {
      run.stdout = (run.stdout + String(data)).slice(-4096);
    });
    child.stderr!.on('data', (data) => {
      run.stderr = (run.stderr + String(data)).slice(-4096);
    });
    child.stdin!.end(ticket + '\n');
    this.runs.push(run);
    return run;
  }
  publisher(fixture: Fixture, ticket: Ticket, duration: number) {
    return this.start(
      resolve('tools/synthetic-motion/publisher.py'),
      [
        '--url',
        process.env.E2E_API_URL!.replace('http:', 'ws:') +
          ticket.websocket_path,
        '--session-id',
        fixture.session_id,
        '--scene-hash',
        fixture.scene_hash,
        '--ticket-stdin',
        '--duration',
        String(duration),
      ],
      ticket.ticket,
    );
  }
  async stop(run: ProcessRun) {
    await this.ledger.stop(run.child.pid!);
    this.ledger.reconcile('actor-stopped');
  }
  async cleanup() {
    this.ledger.data.closing = true;
    this.ledger.save();
    for (const run of this.runs) await this.stop(run);
    this.ledger.reconcile('motion-case-complete');
    this.ledger.snapshot('end');
  }
}
export async function register(page: Page) {
  await page.goto('/register');
  await page
    .getByLabel('邮箱', { exact: true })
    .fill(`motion-${randomUUID()}@example.test`);
  await page
    .getByLabel('密码', { exact: true })
    .fill('independent-motion-browser-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/lab$/);
}
export async function prepare(page: Page, browser: Browser) {
  await register(page);
  const session = await (await page.request.get('/api/v1/auth/session')).json();
  const api = new CoreHttp(process.env.E2E_API_URL!);
  api.cookie = (await page.context().cookies())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  api.csrf = session.csrf_token;
  const asset = await publishAsset(
    api,
    readFileSync('tests/fixtures/lab/cube.glb'),
    'Independent motion GLB',
  );
  const lab = await api.json<{ id: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Independent motion Lab' },
    201,
  );
  const fixture = await api.json<Fixture>(
    'POST',
    `/api/v1/lab/labs/${lab.id}/motion-fixture`,
    { representation_id: asset.representation.id },
    201,
  );
  const secondContext = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
  });
  const second = await secondContext.newPage();
  await register(second);
  for (const viewer of [page, second]) {
    await viewer.goto(`/lab?lab=${lab.id}`);
    await expect(
      viewer.getByRole('heading', {
        name: 'Independent motion Lab',
        exact: true,
      }),
    ).toBeVisible();
    await expectInitialSceneReady(viewer.locator('.world-page'));
    await viewer.getByRole('button', { name: '性能', exact: true }).click();
  }
  return {
    fixture,
    api,
    second,
    secondContext,
    before: await api.json('GET', `/api/v1/lab/labs/${lab.id}/world`),
  };
}
export async function joinViewer(page: Page, rate: 15 | 30) {
  await page.getByRole('button', { name: /^合成运动/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('接收频率', { exact: true })
    .selectOption(String(rate));
  await dialog
    .getByRole('button', { name: '加入已有会话', exact: true })
    .click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
}
export async function leaveViewer(page: Page) {
  await page.getByRole('button', { name: /^合成运动/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '离开运动', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect.poll(() => displayed(page)).toBeNull();
}
export function wireObserver(page: Page) {
  const state = {
    frames: 0,
    bytes: 0,
    errors: [] as string[],
    epochs: [] as string[],
  };
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/viewer')) return;
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') return;
      state.frames++;
      state.bytes += frame.payload.length;
      try {
        if (state.frames <= 3 || state.frames % 30 === 0) {
          const header = rawHeader(frame.payload);
          if (!state.epochs.includes(header.epoch))
            state.epochs.push(header.epoch);
        }
      } catch (error) {
        if (state.errors.length < 4)
          state.errors.push(
            error instanceof Error ? error.name : 'OracleError',
          );
      }
    });
  });
  return state;
}
export async function ready(page: Page) {
  return eventually(
    () => displayed(page),
    (value) => value?.nodes.length === 20,
  ).then((value) => value as Diagnostic);
}
export async function pixels(page: Page, name: string) {
  const rect = (await page.locator('canvas').boundingBox())!;
  const png = await page
    .locator('canvas')
    .screenshot({ path: join(rootEvidence, name + '.png') });
  const count = await page.evaluate(
    async ({ encoded, rect }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + encoded;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      let visible = 0;
      for (let y = 0; y < image.height; y += 2)
        for (let x = 0; x < image.width; x += 2) {
          const i = (y * image.width + x) * 4;
          const values = [data[i], data[i + 1], data[i + 2]];
          if (
            Math.max(...values) > 80 &&
            Math.max(...values) - Math.min(...values) > 25 &&
            document.elementFromPoint(
              rect.x + (x * rect.width) / image.width,
              rect.y + (y * rect.height) / image.height,
            )?.tagName === 'CANVAS'
          )
            visible++;
        }
      return visible;
    },
    { encoded: png.toString('base64'), rect },
  );
  expect(count).toBeGreaterThan(80);
  return count;
}
export async function metrics(page: Page) {
  return page.locator('.lab-perf').evaluate((panel) => ({
    fps: Number(panel.querySelector('.lab-perf-main strong')?.textContent),
    frameMs: Number(
      panel.querySelector('.lab-perf-main small')?.textContent?.split(' ')[0],
    ),
    stats: Object.fromEntries(
      Array.from(panel.querySelectorAll('dl > div')).map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent,
      ]),
    ),
  }));
}
export async function ticket(
  api: CoreHttp,
  fixture: Fixture,
  role: 'viewer' | 'publisher',
  rate = 30,
) {
  return api.json<Ticket>(
    'POST',
    `/api/v1/lab/labs/${fixture.lab_id}/motion-fixture/${fixture.session_id}/${role}-tickets`,
    { preferred_rate_hz: rate },
    201,
  );
}
export async function rawAdmission(
  fixture: Fixture,
  value: Ticket,
  role: 'viewer' | 'publisher',
  origin = process.env.E2E_WEB_URL!,
) {
  const ws = new WebSocket(
    process.env.E2E_API_URL!.replace('http:', 'ws:') + value.websocket_path,
    { origin },
  );
  const messages: { binary: boolean; data: Buffer }[] = [];
  ws.on('error', () => {});
  ws.on('message', (data, binary) =>
    messages.push({ binary, data: Buffer.from(data as Buffer) }),
  );
  await once(ws, 'open');
  ws.send(
    JSON.stringify({
      type: 'motion.hello',
      version: 1,
      codec: 'pose-f32-v1',
      role,
      session_id: fixture.session_id,
      scene_hash: role === 'publisher' ? fixture.scene_hash : undefined,
      ticket: value.ticket,
      preferred_rate_hz: 30,
    }),
  );
  await eventually(
    async () => messages.length,
    (count) => count > 0,
  );
  return { ws, messages };
}
export async function unmaskedError(fixture: Fixture) {
  const url = new URL(process.env.E2E_API_URL!);
  const socket = tcpConnect(Number(url.port), url.hostname);
  await once(socket, 'connect');
  let received = '';
  socket.on('data', (data) => {
    received += data.toString('latin1');
  });
  socket.write(
    `GET /api/v1/lab/motion/sessions/${fixture.session_id}/viewer HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${process.env.E2E_WEB_URL}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  try {
    await eventually(
      async () => received,
      (value) => value.includes('101 Switching Protocols'),
    );
    socket.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
    await eventually(async () => socket.destroyed, Boolean, 5000);
  } finally {
    socket.destroy();
  }
}
export async function closeContext(context: BrowserContext) {
  await context.close();
}
