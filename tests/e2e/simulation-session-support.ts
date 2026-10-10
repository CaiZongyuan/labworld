import { expect, type Page, type Browser } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { expectInitialSceneReady } from './initial-scene-ready';
import type {
  LabWorld,
  SceneInstallation,
  SimulationSession,
  SimulationSessionPage,
  SessionMotionTicket,
} from '../../packages/contracts/src/generated/types.gen';
import { CoreHttp } from '../support/core-http';
import { publishAsset, rewriteGlb } from '../support/lab-assets-http';
import {
  register,
  eventually,
  receipt,
  stage,
  pixels,
  metrics,
} from './motion-support';
import { displayed, type Diagnostic } from './motion-oracle';
import {
  readSessionFrame,
  assertSessionFrame,
  type SessionFrame,
} from './simulation-session-oracle';

export {
  eventually,
  receipt,
  stage,
  pixels,
  metrics,
  displayed,
  expectInitialSceneReady,
};
export const sessionsPath = (lab: string) => `/api/v1/lab/labs/${lab}/sessions`;
export const sessionPath = (lab: string, id: string) =>
  `${sessionsPath(lab)}/${id}`;
export const lifecycleLabel: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  interrupted: 'Session interrupted',
  starting: 'Starting',
  pausing: 'Pausing',
  resuming: 'Resuming',
};
export async function dialog(page: Page) {
  const current = page.getByRole('dialog', {
    name: 'Simulation Session',
    exact: true,
  });
  if (!(await current.isVisible()))
    await page.getByRole('button', { name: /^Simulation Session/ }).click();
  return current;
}
export async function closeDialog(page: Page) {
  const value = await dialog(page);
  await value.getByRole('button', { name: 'Close', exact: true }).click();
}
export async function lifecycle(page: Page, state: string) {
  const value = await dialog(page);
  await expect(
    value.getByRole('status', { name: 'Session lifecycle' }),
  ).toContainText(lifecycleLabel[state]);
  await value.getByRole('button', { name: 'Close', exact: true }).click();
}
export async function action(
  page: Page,
  lab: string,
  id: string | null,
  name: 'Start' | 'Pause' | 'Resume' | 'Reset' | 'Stop',
) {
  const value = await dialog(page),
    path = id
      ? `${sessionPath(lab, id)}/${name.toLowerCase()}`
      : sessionsPath(lab);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === path && r.request().method() === 'POST',
    ),
    value.getByRole('button', { name, exact: true }).click(),
  ]);
  expect(response.status()).toBe(name === 'Start' ? 201 : 200);
  const session = (await response.json()) as SimulationSession;
  await value.getByRole('button', { name: 'Close', exact: true }).click();
  return session;
}
export async function authority(
  api: CoreHttp,
  lab: string,
  id: string,
  status: SimulationSession['status'],
) {
  return eventually(
    () => api.json<SimulationSession>('GET', sessionPath(lab, id)),
    (value) => value.status === status,
  );
}
export async function pose(
  page: Page,
  id: string,
  boundary?: SessionFrame,
): Promise<Diagnostic> {
  return eventually(
    () => displayed(page),
    (value) =>
      value !== null &&
      value.session_id === id &&
      value.nodes.length === 20 &&
      (!boundary ||
        value.nodes.every(
          (n) =>
            n.sequence === boundary.sequence &&
            n.sim_time_ns === boundary.sim_time_ns,
        )),
  ).then((value) => value as Diagnostic);
}
export async function select(page: Page, name: string) {
  const directory = page.getByRole('button', {
    name: '打开对象目录',
    exact: true,
  });
  if ((await directory.getAttribute('aria-expanded')) === 'false')
    await directory.click();
  await page.getByRole('button', { name: `选择 ${name}`, exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: '对象信息' }),
  ).toContainText(name);
}
export const world = (api: CoreHttp, lab: string) =>
  api.json<LabWorld>('GET', `/api/v1/lab/labs/${lab}/world`);
export function layoutInput(value: LabWorld) {
  return {
    expected_version: value.lab.layout_version,
    nodes: value.nodes.map(
      ({ id, entity_id, representation_id, placement }) => ({
        id,
        entity_id,
        representation_id,
        placement,
      }),
    ),
    relationships: value.relationships.map(
      ({ id, source_id, target_id, kind }) => ({
        id,
        source_id,
        target_id,
        kind,
      }),
    ),
  };
}
export async function savedLayout(api: CoreHttp, lab: string, value: LabWorld) {
  await api.json('PUT', `/api/v1/lab/labs/${lab}/layout`, layoutInput(value));
  return world(api, lab);
}
export async function prepareSession(page: Page, browser: Browser) {
  await register(page);
  const auth = await (await page.request.get('/api/v1/auth/session')).json();
  const api = new CoreHttp(process.env.E2E_API_URL!);
  api.cookie = (await page.context().cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  api.csrf = auth.csrf_token;
  const bytes = readFileSync('tests/fixtures/lab/cube.glb');
  const firstBytes = rewriteGlb(bytes, (root) => {
    const materials = root.materials as {
      pbrMetallicRoughness: { baseColorFactor: number[] };
    }[];
    materials[0].pbrMetallicRoughness.baseColorFactor = [0.12, 0.7, 0.25, 1];
  });
  const firstAsset = await publishAsset(api, firstBytes, 'Session pinned GLB');
  const changedBytes = rewriteGlb(bytes, (root) => {
    const materials = root.materials as {
      pbrMetallicRoughness: { baseColorFactor: number[] };
    }[];
    materials[0].pbrMetallicRoughness.baseColorFactor = [0.7, 0.15, 0.65, 1];
  });
  const nextAsset = await publishAsset(
    api,
    changedBytes,
    'Session next appearance',
  );
  const lab = await api.json<{ id: string; name: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Independent Session Lab' },
    201,
  );
  const otherLab = await api.json<{ id: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Independent Installation identity Lab' },
    201,
  );
  const emptyLab = await api.json<{ id: string; name: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Session resource convergence empty Lab' },
    201,
  );
  await page.goto(`/lab?lab=${lab.id}`);
  await expectInitialSceneReady(page.locator('.world-page'));
  const value = await dialog(page);
  await value
    .getByLabel('GLB model', { exact: true })
    .selectOption(firstAsset.representation.id);
  const installPath = `/api/v1/lab/labs/${lab.id}/installations`;
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === installPath &&
        r.request().method() === 'POST',
    ),
    value
      .getByRole('button', { name: 'Install fixed scene', exact: true })
      .click(),
  ]);
  expect(response.status()).toBe(201);
  const installation = (await response.json()) as SceneInstallation;
  await value.getByRole('button', { name: 'Close', exact: true }).click();
  const independent = await api.json<SceneInstallation>(
    'POST',
    `/api/v1/lab/labs/${otherLab.id}/installations`,
    { representation_id: firstAsset.representation.id },
    201,
  );
  assert.equal(installation.targets.length, 20);
  assert.equal(installation.joint_keys.length, 6);
  assert(
    installation.targets.every(
      (t) =>
        !independent.targets.some(
          (u) => u.entity_id === t.entity_id || u.node_id === t.node_id,
        ),
    ),
  );
  const bench = await api.json<{ id: string }>(
    'POST',
    `/api/v1/lab/labs/${lab.id}/entities`,
    {
      name: 'Manual registered location',
      definition_id: 'bench',
      definition_version: '1.0',
      reality: 'physical',
      configuration: {},
      representation_id: null,
    },
    201,
  );
  const initial = await world(api, lab.id),
    target = installation.targets[0];
  const mappedIds = new Set(installation.targets.map((item) => item.node_id));
  initial.nodes = initial.nodes.filter((item) => mappedIds.has(item.id));
  const node = initial.nodes.find((n) => n.id === target.node_id)!;
  node.placement = {
    position: [-3.4, 0.8, -2.2],
    rotation: [0.2, 0.3, -0.15],
    scale: [1.1, 0.8, 1.2],
  };
  await api.json('PUT', `/api/v1/lab/labs/${lab.id}/layout`, {
    ...layoutInput(initial),
    relationships: [
      ...layoutInput(initial).relationships,
      {
        id: randomUUID(),
        source_id: target.entity_id,
        target_id: bench.id,
        kind: 'located_in',
      },
    ],
  });
  const before = await world(api, lab.id);
  assert(
    before.relationships.some(
      (item) =>
        item.source_id === target.entity_id &&
        item.target_id === bench.id &&
        item.kind === 'located_in' &&
        item.source === 'manual',
    ),
  );
  const secondContext = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
  });
  try {
    const second = await secondContext.newPage();
    await register(second);
    await second.goto(`/lab?lab=${lab.id}`);
    await expectInitialSceneReady(second.locator('.world-page'));
    for (const viewer of [page, second]) {
      await expectInitialSceneReady(viewer.locator('.world-page'));
      const controls = await dialog(viewer);
      await controls
        .getByLabel('Scene Installation', { exact: true })
        .selectOption(installation.id);
      await controls
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await viewer.getByRole('button', { name: '性能', exact: true }).click();
    }
    const enabled = await api.json<SimulationSessionPage>(
      'GET',
      sessionsPath(lab.id),
    );
    assert.equal(enabled.development_synthetic_enabled, true);
    return {
      api,
      lab,
      otherLab,
      emptyLab,
      installation,
      independent,
      firstAsset,
      nextAsset,
      before,
      second,
      secondContext,
    };
  } catch (error) {
    await secondContext.close().catch(() => {});
    throw error;
  }
}

const socketOwnership = new Map<
  WebSocket,
  {
    role: string;
    session_id: string;
    state: string;
    localPort?: number;
    remotePort?: number;
  }
>();
export function ownSessionSocket(
  socket: WebSocket,
  role: string,
  sessionId: string,
) {
  const row = { role, session_id: sessionId, state: 'connecting' } as {
    role: string;
    session_id: string;
    state: string;
    localPort?: number;
    remotePort?: number;
  };
  socketOwnership.set(socket, row);
  const record = () =>
    receipt('session-socket-ownership', {
      owner: 'Independent issue71 public HTTP/WS verifier',
      pid: process.pid,
      sockets: [...socketOwnership.values()],
    });
  socket.on('open', () => {
    row.state = 'open';
    const peer = (
      socket as unknown as {
        _socket?: { localPort?: number; remotePort?: number };
      }
    )._socket;
    row.localPort = peer?.localPort;
    row.remotePort = peer?.remotePort;
    record();
  });
  socket.on('close', () => {
    row.state = 'closed';
    record();
  });
  record();
}
export async function closeSessionSockets() {
  const results = await Promise.allSettled(
    [...socketOwnership.keys()].map(async (socket) => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await eventually(
        async () => socket.readyState,
        (value) => value === WebSocket.CLOSED,
      );
    }),
  );
  receipt('session-socket-final', {
    owner: process.pid,
    sockets: [...socketOwnership.values()],
    allClosed: [...socketOwnership.keys()].every(
      (socket) => socket.readyState === WebSocket.CLOSED,
    ),
  });
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
export class SessionWire {
  private sessions = new Map<
    string,
    {
      frames: number;
      welcomeCount: number;
      latest?: SessionFrame;
      first?: SessionFrame;
      state?: string;
      errors: string[];
      resume?: { after: bigint; first?: SessionFrame };
    }
  >();
  constructor(page: Page) {
    page.on('websocket', (socket) => {
      if (!socket.url().endsWith('/viewer')) return;
      let id: string | undefined;
      let epoch: string | undefined,
        lastSequence = -1n;
      socket.on('framereceived', (event) => {
        try {
          if (typeof event.payload === 'string') {
            const message = JSON.parse(event.payload);
            if (message.type === 'motion.welcome') {
              id = message.session_id;
              const current = this.sessions.get(id!) ?? {
                frames: 0,
                welcomeCount: 0,
                errors: [],
              };
              current.welcomeCount++;
              this.sessions.set(id!, current);
              epoch = message.epoch;
              lastSequence = -1n;
            } else if (id && message.type === 'motion.status')
              this.sessions.get(id)!.state = message.state;
          } else if (id) {
            const current = this.sessions.get(id)!;
            current.frames++;
            const frame = readSessionFrame(event.payload);
            assert.equal(frame.epoch, epoch);
            assert(BigInt(frame.sequence) > lastSequence);
            lastSequence = BigInt(frame.sequence);
            current.latest = frame;
            current.first ??= frame;
            if (
              current.resume &&
              !current.resume.first &&
              BigInt(frame.sequence) > current.resume.after
            )
              current.resume.first = frame;
          }
        } catch (error) {
          if (id)
            this.sessions
              .get(id)!
              .errors.push(error instanceof Error ? error.name : 'WireError');
        }
      });
    });
  }
  get(id: string) {
    return this.sessions.get(id);
  }
  armResume(id: string, boundary: SessionFrame) {
    const session = this.sessions.get(id);
    assert(session);
    session.resume = { after: BigInt(boundary.sequence) };
  }
  async resumedBoundary(id: string) {
    return eventually(
      async () => this.sessions.get(id)?.resume?.first,
      Boolean,
    ).then((value) => value!);
  }
}
export class SessionRawViewer {
  readonly socket: WebSocket;
  latest?: SessionFrame;
  state?: string;
  errors: string[] = [];
  welcome?: Record<string, unknown>;
  constructor(session: SimulationSession, ticket: SessionMotionTicket) {
    this.socket = new WebSocket(
      process.env.E2E_API_URL!.replace('http:', 'ws:') + ticket.websocket_path,
      { origin: process.env.E2E_WEB_URL! },
    );
    ownSessionSocket(this.socket, 'raw-viewer', session.id);
    this.socket.on('error', (error) => this.errors.push(error.name));
    this.socket.on('message', (data, binary) => {
      try {
        if (binary)
          this.latest = readSessionFrame(Buffer.from(data as Uint8Array));
        else {
          const value = JSON.parse(String(data));
          if (value.type === 'motion.welcome') this.welcome = value;
          else if (value.type === 'motion.status') this.state = value.state;
          else if (value.type === 'motion.error') this.errors.push(value.code);
        }
      } catch (error) {
        this.errors.push(error instanceof Error ? error.name : 'WireError');
      }
    });
    this.socket.once('open', () =>
      this.socket.send(
        JSON.stringify({
          type: 'motion.hello',
          version: 1,
          codec: 'pose-f32-v1',
          role: 'viewer',
          session_id: session.id,
          ticket: ticket.ticket,
          preferred_rate_hz: 30,
        }),
      ),
    );
  }
  async boundary(session: SimulationSession) {
    const value = await eventually(
      async () => this.latest,
      (frame) => this.state === 'paused' && !!this.welcome && !!frame,
    );
    assert.equal(this.welcome?.session_id, session.id);
    assert.equal(
      this.welcome?.scene_hash,
      session.snapshot.installation.scene_hash,
    );
    assert.equal(this.welcome?.epoch, session.epoch);
    assert.deepEqual(this.errors, []);
    assertSessionFrame(session, value!);
    return value!;
  }
  async close() {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    await eventually(
      async () => this.socket.readyState,
      (value) => value === WebSocket.CLOSED,
    );
  }
}
export async function pauseBoundary(
  api: CoreHttp,
  lab: string,
  session: SimulationSession,
  owned: SessionRawViewer[],
) {
  const ticket = await api.json<SessionMotionTicket>(
    'POST',
    `${sessionPath(lab, session.id)}/viewer-tickets`,
    { preferred_rate_hz: 30 },
    201,
  );
  const reader = new SessionRawViewer(session, ticket);
  owned.push(reader);
  return reader.boundary(session);
}
export async function maskedCanvas(page: Page) {
  return createHash('sha256')
    .update(
      await page
        .locator('canvas')
        .screenshot({ mask: [page.locator('.lab-perf')] }),
    )
    .digest('hex');
}
export async function appearancePixels(page: Page, label: string) {
  const buffer = await page.locator('canvas').screenshot();
  const rect = (await page.locator('canvas').boundingBox())!;
  const result = await page.evaluate(
    async ({ encoded, rect }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + encoded;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const bytes = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let green = 0,
        purple = 0;
      for (let y = 0; y < image.height; y += 2)
        for (let x = 0; x < image.width; x += 2) {
          if (
            document.elementFromPoint(
              rect.x + (x * rect.width) / image.width,
              rect.y + (y * rect.height) / image.height,
            )?.tagName !== 'CANVAS'
          )
            continue;
          const i = (y * image.width + x) * 4,
            r = bytes[i],
            g = bytes[i + 1],
            b = bytes[i + 2];
          if (g > 60 && g > r * 1.3 && g > b * 1.3) green++;
          if (r > 60 && b > 60 && r > g * 1.4 && b > g * 1.4) purple++;
        }
      return { green, purple };
    },
    { encoded: buffer.toString('base64'), rect },
  );
  receipt(label, result);
  return result;
}
export async function leaveSession(page: Page) {
  const value = await dialog(page);
  await value
    .getByRole('button', { name: 'Leave observation', exact: true })
    .click();
  await value.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => displayed(page)).toBeNull();
}
export async function observeSession(page: Page) {
  const value = await dialog(page);
  await value
    .getByRole('button', { name: 'Observe Session', exact: true })
    .click();
  await value.getByRole('button', { name: 'Close', exact: true }).click();
}
export async function openLab(page: Page, lab: { id: string; name: string }) {
  await page.getByLabel('打开 Lab', { exact: true }).selectOption(lab.id);
  await expect(
    page.getByRole('heading', { name: lab.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.world-page')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const performance = page.getByRole('button', { name: '性能', exact: true });
  if ((await performance.getAttribute('aria-pressed')) === 'false')
    await performance.click();
}
export async function resourceCounts(page: Page) {
  const value = await metrics(page);
  const result = {
    geometries: Number(value.stats.Geometries),
    textures: Number(value.stats.Textures),
  };
  assert(
    Number.isInteger(result.geometries) && Number.isInteger(result.textures),
  );
  return result;
}
export async function settledResourceCounts(page: Page) {
  let previous: Awaited<ReturnType<typeof resourceCounts>> | undefined;
  let stableAt = performance.now();
  return eventually(
    () => resourceCounts(page),
    (value) => {
      if (
        !previous ||
        previous.geometries !== value.geometries ||
        previous.textures !== value.textures
      )
        stableAt = performance.now();
      previous = value;
      return performance.now() - stableAt >= 750;
    },
    5000,
  );
}
export async function reopenOwnedApi() {
  const pidFile = process.env.E2E_API_PID_FILE!;
  const oldPid = Number(readFileSync(pidFile, 'utf8'));
  const ledgerPath = join(
    process.env.LAB_NODE_EVIDENCE!,
    'owned-resources.json',
  );
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const proof = ledger.processes.find((p: { pid: number }) => p.pid === oldPid);
  assert(proof);
  const stat = readFileSync(`/proc/${oldPid}/stat`, 'utf8')
    .split(') ')[1]
    .split(' ');
  assert.equal(stat[19], proof.start);
  process.kill(oldPid, 'SIGKILL');
  const newPid = await eventually(
    async () => Number(readFileSync(pidFile, 'utf8')),
    (value) => value !== oldPid,
  );
  const api = new CoreHttp(process.env.E2E_API_URL!);
  await eventually(
    async () => api.json<{ status: string }>('GET', '/health/ready'),
    (value) => value.status === 'ok',
  );
  receipt('session-owned-reopen', {
    oldPid,
    newPid,
    ledgerPath,
    signal: 'SIGKILL',
    purpose: 'owned abrupt recovery, no implicit replay',
  });
  return { oldPid, newPid };
}
