import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { WebSocket, type ClientOptions } from 'ws';
import { randomUUID } from 'node:crypto';
import type {
  SimulationSession,
  SessionMotionTicket,
  CreatedApiKey,
} from '../../packages/contracts/src/generated/types.gen';
import { CoreHttp } from '../support/core-http';
import { register } from './motion-support';
import {
  prepareSession,
  action,
  authority,
  pose,
  dialog,
  pixels,
  SessionRawViewer,
  closeSessionSockets,
  sessionPath,
  eventually,
  receipt,
  displayed,
} from './simulation-session-support';
import {
  assertSessionGeometry,
  assertSessionFrame,
} from './simulation-session-oracle';
import {
  publicRecording,
  recordingForSession,
  recordingPath,
} from './recording-public-support';
import { recordedFrames, recordedSourcePackets } from './recording-wire-oracle';
import { readSessionFrame } from './simulation-session-oracle';
import { OwnedMotionActor } from './secure-motion-source';
import { assertPrivateDenial } from './secure-motion-oracle';
import { assertSourceWitness } from './secure-source-witness';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });

const peers = new Set<SecurityPeer>();
const denials: ReturnType<typeof assertPrivateDenial>[] = [];
class SecurityPeer {
  socket: WebSocket;
  controls: Record<string, unknown>[] = [];
  binaryBytes = 0;
  failure?: Error & { code?: string };
  closed: Promise<void>;
  closeReason = '';
  openedAt?: number;
  closedAt?: number;
  constructor(
    session: SimulationSession,
    ticket: SessionMotionTicket,
    {
      scene = session.snapshot.installation.scene_hash,
      origin = process.env.E2E_WEB_URL!,
      role = 'viewer',
      token = ticket.ticket,
      options = {},
      binary = false,
      silent = false,
      helloSession = session.id,
    }: {
      scene?: string;
      origin?: string | null;
      role?: string;
      token?: string;
      options?: ClientOptions;
      binary?: boolean;
      silent?: boolean;
      helloSession?: string;
    } = {},
  ) {
    this.socket = new WebSocket(
      process.env.E2E_API_URL!.replace(/^http/, 'ws') + ticket.websocket_path,
      { ...(origin === null ? {} : { origin }), ...options },
    );
    peers.add(this);
    this.closed = new Promise((resolve) =>
      this.socket.once('close', (_code, reason) => {
        this.closeReason = reason.toString();
        this.closedAt = performance.now();
        resolve();
      }),
    );
    this.socket.on('error', (error) => {
      this.failure = error;
    });
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) this.binaryBytes += Buffer.byteLength(data as Buffer);
      else {
        assert(this.controls.length < 16);
        this.controls.push(JSON.parse(String(data)));
      }
    });
    this.socket.once('open', () => {
      this.openedAt = performance.now();
      if (silent) return;
      this.socket.send(
        binary
          ? Buffer.alloc(4)
          : JSON.stringify({
              type: 'motion.hello',
              version: 1,
              codec: 'pose-f32-v1',
              role,
              session_id: helloSession,
              scene_hash: scene,
              ticket: token,
              preferred_rate_hz: 30,
            }),
      );
    });
  }
  async admitted() {
    await eventually(
      async () =>
        this.controls.some((control) => control.type === 'motion.welcome'),
      Boolean,
    );
    assert(!this.failure);
  }
  async denied() {
    await eventually(
      async () => this.socket.readyState === WebSocket.CLOSED,
      Boolean,
    );
    const observed = assertPrivateDenial(
      this.binaryBytes,
      this.controls,
      this.closeReason,
    );
    denials.push(observed);
    return observed;
  }
  async close() {
    this.socket.terminate();
    await this.closed;
    peers.delete(this);
  }
}

async function ticket(api: CoreHttp, session: SimulationSession) {
  return api.json<SessionMotionTicket>(
    'POST',
    sessionPath(session.lab_id, session.id) + '/viewer-tickets',
    { preferred_rate_hz: 30 },
    201,
  );
}
async function cleanupPeers() {
  await Promise.all([...peers].map((peer) => peer.close()));
  await closeSessionSockets();
}

function gatewayFacts() {
  const directory = process.env.MOTION_E2E_OBSERVER_DIR!;
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
          directPoseDbCalls: number;
          pendingMaxSlots: number;
          pendingMaxBytes: number;
          sockets: {
            role: string;
            scopeId: string;
            admitted: boolean;
            encrypted: boolean;
            remotePort: number;
            maxBufferBytes: number;
            open: boolean;
            closeReason: string | null;
            softCrossedAt: number | null;
            closeRequestedAt: number | null;
          }[];
        },
    );
}

async function sourcePairClosed(
  session: string,
  recording: string,
  deadline: number,
) {
  const pair = await eventually(
    async () =>
      gatewayFacts()
        .flatMap((value) => value.sockets)
        .filter(
          (socket) =>
            socket.admitted &&
            ((socket.role === 'publisher' && socket.scopeId === session) ||
              (socket.role === 'source' && socket.scopeId === recording)),
        ),
    (sockets) =>
      sockets.length === 2 && sockets.every((socket) => !socket.open),
    Math.max(1, deadline - performance.now()),
  );
  assert.equal(pair.length, 2);
  assert(pair.every((socket) => socket.encrypted && !socket.open));
  return {
    publisherClosed: pair.some((socket) => socket.role === 'publisher'),
    recordingClosed: pair.some((socket) => socket.role === 'source'),
  };
}

test('trusted WSS journey: two real WebGL views recover with fresh tickets, paused late join and successor Recording', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  assert(process.env.E2E_API_URL?.startsWith('https://'));
  let f: Awaited<ReturnType<typeof prepareSession>> | undefined;
  let active: SimulationSession | undefined;
  const contexts = [];
  let signed = 0;
  let closedViewerSockets = 0;
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.endsWith('/viewer'))
      socket.on('close', () => closedViewerSockets++);
  });
  page.on('response', (response) => {
    if (
      new URL(response.url()).pathname.endsWith('/viewer-tickets') &&
      response.status() === 201
    )
      signed++;
  });
  try {
    f = await prepareSession(page, browser);
    active = await action(page, f.lab.id, null, 'Start');
    active = await authority(f.api, f.lab.id, active.id, 'running');
    const wire = new SessionRawViewer(active, await ticket(f.api, active));
    for (const [index, viewer] of [page, f.second].entries()) {
      assertSessionGeometry(await pose(viewer, active.id), active);
      await pixels(viewer, 'secure-motion-view-' + index);
    }
    const before = await pose(page, active.id),
      firstTickets = signed,
      closedBefore = closedViewerSockets;
    const recoveryDialog = await dialog(page);
    await page.context().setOffline(true);
    await expect.poll(() => closedViewerSockets).toBeGreaterThan(closedBefore);
    await expect(
      recoveryDialog.getByRole('status', { name: '运动接收' }),
    ).toContainText('运动过期');
    const frozen = await displayed(page);
    assert(frozen && frozen.session_id === active.id);
    const secondBefore = await pose(f.second, active.id);
    await eventually(
      async () => (await pose(f!.second, active!.id)).nodes[0].sequence,
      (sequence) =>
        BigInt(sequence) > BigInt(secondBefore.nodes[0].sequence) + 5n,
    );
    assert.deepEqual((await displayed(page))?.nodes, frozen.nodes);
    await page.context().setOffline(false);
    await expect.poll(() => signed).toBeGreaterThan(firstTickets);
    await eventually(
      async () => displayed(page),
      (value) =>
        !!value &&
        value.session_id === active!.id &&
        value.epoch === active!.epoch &&
        BigInt(value.nodes[0].sequence) > BigInt(before.nodes[0].sequence),
    );
    await recoveryDialog
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    assertSessionGeometry(await pose(page, active.id), active);
    await action(page, f.lab.id, active.id, 'Pause');
    const paused = await authority(f.api, f.lab.id, active.id, 'paused');
    const boundary = await wire.boundary(paused);
    assertSessionFrame(paused, boundary);
    const lateContext = await browser.newContext({
      baseURL: process.env.E2E_WEB_URL,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(lateContext);
    const late = await lateContext.newPage();
    await register(late);
    await late.goto(`/lab?lab=${f.lab.id}`);
    assertSessionGeometry(
      await pose(late, paused.id, boundary),
      paused,
      boundary,
    );
    const controls = await dialog(late);
    await expect(
      controls.getByRole('status', { name: '运动接收' }),
    ).toContainText('已暂停');
    await controls.getByRole('button', { name: '关闭', exact: true }).click();
    const oldScopeTicket = await ticket(f.api, active);
    const oldScopeIssuedAt = performance.now();
    await page.context().setOffline(true);
    const old = active;
    active = await action(f.second, f.lab.id, old.id, 'Reset');
    active = await authority(f.api, f.lab.id, active.id, 'running');
    assert.notEqual(active.id, old.id);
    assert.notEqual(active.epoch, old.epoch);
    assert(performance.now() - oldScopeIssuedAt < 30000);
    const wrongScope = new SecurityPeer(active, {
      ...oldScopeTicket,
      websocket_path: oldScopeTicket.websocket_path.replace(old.id, active.id),
    });
    await wrongScope.denied();
    await wrongScope.close();
    await page.context().setOffline(false);
    assertSessionGeometry(await pose(page, active.id), active);
    assertSessionGeometry(await pose(f.second, active.id), active);
    const oldRecording = await recordingForSession(f.api, f.lab.id, old.id);
    await eventually(
      () =>
        f!.api.json<{ status: string }>(
          'GET',
          recordingPath(f!.lab.id, oldRecording.id),
        ),
      (value) => value.status === 'complete',
      10000,
    );
    const oldRead = await publicRecording(f.api, f.lab.id, oldRecording.id);
    assert.equal(oldRead.metadata.snapshot_hash, old.snapshot.hash);
    assert.equal(oldRead.metadata.prefix.source_ended, true);
    const frames = recordedFrames(recordedSourcePackets(oldRead.records));
    assert(frames.length > 2);
    assertSessionFrame(old, readSessionFrame(frames.at(-1)!));
    const oldBytes = assertSourceWitness(old.id, oldRead.records, true);
    await action(f.second, f.lab.id, active.id, 'Stop');
    await authority(f.api, f.lab.id, active.id, 'stopped');
    const successorRecording = await recordingForSession(
      f.api,
      f.lab.id,
      active.id,
    );
    await eventually(
      () =>
        f!.api.json<{ status: string }>(
          'GET',
          recordingPath(f!.lab.id, successorRecording.id),
        ),
      (value) => value.status === 'complete',
      10000,
    );
    const successorRead = await publicRecording(
      f.api,
      f.lab.id,
      successorRecording.id,
    );
    const successorBytes = assertSourceWitness(
      active.id,
      successorRead.records,
      true,
    );
    receipt('secure-wss-real-journey', {
      scope:
        'local trusted TLS; production Synthetic; no remote/public/WAN proof',
      initialTickets: firstTickets,
      finalTickets: signed,
      offlineViewerSocketClosed: closedViewerSockets > closedBefore,
      offlinePoseFrozen: true,
      oldSourceFrames: frames.length,
      oldSourceEnded: oldRead.metadata.prefix.source_ended,
      oldSourceBytes: oldBytes,
      successorSourceBytes: successorBytes,
      oldEpoch: old.epoch,
      successorEpoch: active.epoch,
    });
    active = undefined;
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => {});
    await cleanupPeers();
    for (const context of contexts) await context.close();
    await f?.secondContext.close();
  }
});

test('external trusted source: real machine admission and Recording are fenced on persisted expiry with a valid independent Agent', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  let f: Awaited<ReturnType<typeof prepareSession>> | undefined;
  const source = new OwnedMotionActor('external-source');
  try {
    f = await prepareSession(page, browser);
    const machine = await f.api.json<{
      machine: { id: string; expires_at: string; revoked_at: null };
      credential: string;
    }>(
      'POST',
      '/api/v1/machines',
      { name: 'Independent external trusted source' },
      201,
    );
    let session = await f.api.json<SimulationSession>(
      'POST',
      `/api/v1/lab/labs/${f.lab.id}/sessions`,
      { installation_id: f.installation.id, machine_id: machine.machine.id },
      201,
    );
    const preparing = await f.api.response(
      'POST',
      sessionPath(f.lab.id, session.id) + '/viewer-tickets',
      { preferred_rate_hz: 30 },
    );
    assert.equal(preparing.status, 503);
    const waiting = await preparing.json();
    assert.equal(waiting.error.code, 'lab.publisher_preparing');
    assert.equal(waiting.ticket, undefined);
    const key = await f.api.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Independent non-expiring control',
        scopes: ['lab:full'],
        expires_in_days: 365,
      },
      201,
    );
    const agent = new CoreHttp(process.env.E2E_API_URL!, {
      authorization: 'Bearer ' + key.secret,
    });
    await source.start(
      'tests/support/synthetic-source-witness.py',
      [
        '--witness-remote',
        '--server',
        process.env.E2E_API_URL!,
        '--lab',
        f.lab.id,
        '--session',
        session.id,
        '--machine',
        machine.machine.id,
      ],
      machine.credential,
    );
    session = await authority(f.api, f.lab.id, session.id, 'running');
    assertSessionGeometry(await pose(page, session.id), session);
    assertSessionGeometry(await pose(f.second, session.id), session);
    const initialRecording = await recordingForSession(
      f.api,
      f.lab.id,
      session.id,
    );
    const initialRead = await publicRecording(
      f.api,
      f.lab.id,
      initialRecording.id,
    );
    const frames = recordedFrames(recordedSourcePackets(initialRead.records));
    assert(frames.length > 1);
    assertSessionFrame(session, readSessionFrame(frames.at(-1)!));
    const agentPeer = new SecurityPeer(session, await ticket(agent, session));
    await agentPeer.admitted();
    const started = performance.now();
    writeFileSync(
      process.env.E2E_SERVICE_CONTROL!,
      JSON.stringify({ revision: 1, action: 'expire-machine-clock' }),
    );
    const reply = await eventually(
      async () => {
        try {
          return JSON.parse(
            readFileSync(process.env.E2E_SERVICE_CONTROL_REPLY!, 'utf8'),
          ) as { revision: number; facts: { domain_now: string } };
        } catch {
          return undefined;
        }
      },
      (value) => value?.revision === 1,
    );
    assert(reply);
    assert(
      Date.parse(machine.machine.expires_at) <
        Date.parse(reply.facts.domain_now),
    );
    assert.equal(machine.machine.revoked_at, null);
    const ended = await authority(f.api, f.lab.id, session.id, 'interrupted');
    assert.equal(ended.reason, 'machine_expired');
    await expect
      .poll(() => agentPeer.socket.readyState, { timeout: 5000 })
      .toBe(WebSocket.CLOSED);
    const sourceFences = await sourcePairClosed(
      session.id,
      initialRecording.id,
      started + 5000,
    );
    const closureMs = performance.now() - started;
    assert(closureMs <= 5000);
    assert.equal(
      (await agent.response('GET', `/api/v1/lab/labs/${f.lab.id}/world`))
        .status,
      200,
    );
    const expiredAdmission = await new CoreHttp(process.env.E2E_API_URL!, {
      authorization: 'Bearer ' + machine.credential,
    }).response(
      'POST',
      sessionPath(f.lab.id, session.id) + '/publisher-admissions',
      { machine_id: machine.machine.id },
    );
    assert.equal(expiredAdmission.status, 403);
    assert.equal(
      (await expiredAdmission.json()).error.code,
      'identity.machine_unauthorized',
    );
    await eventually(
      () =>
        f!.api.json<{ status: string }>(
          'GET',
          recordingPath(f!.lab.id, initialRecording.id),
        ),
      (value) => value.status === 'incomplete',
      10000,
    );
    await source.stop();
    const retainedRead = await publicRecording(
      f.api,
      f.lab.id,
      initialRecording.id,
    );
    const retainedBytes = assertSourceWitness(
      session.id,
      retainedRead.records,
      false,
      recordedSourcePackets(initialRead.records),
    );
    receipt('secure-wss-machine-expiry', {
      scope:
        'real persisted credential and TLS; controlled +31-day domain time; actual monotonic closure; no30-daysoak',
      expiresAt: machine.machine.expires_at,
      controlledDomainNow: reply.facts.domain_now,
      observedClosureMs: closureMs,
      independentAgentWorldStatus: 200,
      sourceFences,
      retainedSourceBytes: retainedBytes,
      reason: ended.reason,
      verifiedBeforeExpiryFrames: frames.length,
    });
  } finally {
    await source.stop();
    await cleanupPeers();
    await f?.secondContext.close();
    if (process.env.E2E_SERVICE_CONTROL) {
      writeFileSync(
        process.env.E2E_SERVICE_CONTROL,
        JSON.stringify({ revision: 2, action: 'reset-machine-clock' }),
      );
      await eventually(
        async () => {
          try {
            return JSON.parse(
              readFileSync(process.env.E2E_SERVICE_CONTROL_REPLY!, 'utf8'),
            ).revision;
          } catch {
            return 0;
          }
        },
        (revision) => revision === 2,
      );
    }
  }
});

test('trusted WSS admission: private mapping stays hidden, account/ticket quotas release and real revocation terminates access', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  let f: Awaited<ReturnType<typeof prepareSession>> | undefined;
  let active: SimulationSession | undefined;
  try {
    f = await prepareSession(page, browser);
    active = await action(page, f.lab.id, null, 'Start');
    active = await authority(f.api, f.lab.id, active.id, 'running');
    await pose(page, active.id);
    const negatives = [
      { scene: 'sha256:' + '0'.repeat(64) },
      { origin: null },
      { origin: 'https://wrong-origin.example.test' },
      { role: 'publisher' },
      { token: 'scoped_ticket_unknown_123456789' },
      { binary: true },
      { silent: true },
      { helloSession: randomUUID() },
      { options: { ca: [] } },
      { options: { servername: 'wrong-hostname.example.test' } },
    ];
    for (const negative of negatives) {
      const scoped = await ticket(f.api, active);
      const peer: SecurityPeer = new SecurityPeer(active, scoped, negative);
      await peer.denied();
      if (negative.silent) {
        assert(peer.openedAt !== undefined && peer.closedAt !== undefined);
        assert(
          peer.closedAt - peer.openedAt >= 2900 &&
            peer.closedAt - peer.openedAt < 5000,
        );
      }
      if (negative.options?.servername)
        assert.equal(peer.failure?.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
      await peer.close();
      // Reclaim a ticket rejected at TLS/Origin/pre-auth, if it was never consumed.
      const reclaim = new SecurityPeer(active, scoped);
      await eventually(
        async () =>
          reclaim.controls.some(
            (control) => control.type === 'motion.welcome',
          ) || reclaim.socket.readyState === WebSocket.CLOSED,
        Boolean,
      );
      await reclaim.close();
    }
    const reusable = await ticket(f.api, active);
    const first = new SecurityPeer(active, reusable);
    await first.admitted();
    await first.close();
    const repeat = new SecurityPeer(active, reusable);
    await repeat.denied();
    await repeat.close();
    const cross = await f.api.response(
      'POST',
      sessionPath(f.otherLab.id, active.id) + '/viewer-tickets',
      { preferred_rate_hz: 30 },
    );
    assert.equal(cross.status, 404);
    const anonymous = new CoreHttp(process.env.E2E_API_URL!);
    assert.equal(
      (
        await anonymous.response(
          'POST',
          sessionPath(f.lab.id, active.id) + '/viewer-tickets',
          { preferred_rate_hz: 30 },
        )
      ).status,
      401,
    );
    const noCsrf = new CoreHttp(process.env.E2E_API_URL!);
    noCsrf.cookie = f.api.cookie;
    assert.equal(
      (
        await noCsrf.response(
          'POST',
          sessionPath(f.lab.id, active.id) + '/viewer-tickets',
          { preferred_rate_hz: 30 },
        )
      ).status,
      403,
    );
    const connections: SecurityPeer[] = [];
    const sharedKey = await f.api.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Same account distinct credential',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
      201,
    );
    const sameAccount = new CoreHttp(process.env.E2E_API_URL!, {
      authorization: 'Bearer ' + sharedKey.secret,
    });
    for (let index = 0; index < 7; index++) {
      const peer = new SecurityPeer(
        active,
        await ticket(index % 2 ? f.api : sameAccount, active),
      );
      await peer.admitted();
      connections.push(peer);
    }
    const overflow = new SecurityPeer(
      active,
      await ticket(sameAccount, active),
    );
    await overflow.denied();
    await overflow.close();
    await connections[0].close();
    const replacement = new SecurityPeer(active, await ticket(f.api, active));
    await replacement.admitted();
    for (const peer of connections.slice(1)) await peer.close();
    await replacement.close();
    await f.api.json(
      'DELETE',
      '/api/v1/api-keys/' + sharedKey.key.id,
      undefined,
      204,
    );
    const key = await f.api.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Secure Viewer Agent', scopes: ['lab:full'], expires_in_days: 1 },
      201,
    );
    const agent = new CoreHttp(process.env.E2E_API_URL!, {
      authorization: 'Bearer ' + key.secret,
    });
    const agentPeer = new SecurityPeer(active, await ticket(agent, active));
    await agentPeer.admitted();
    const revoking = performance.now();
    await f.api.json(
      'DELETE',
      '/api/v1/api-keys/' + key.key.id,
      undefined,
      204,
    );
    await expect
      .poll(() => agentPeer.socket.readyState, { timeout: 5000 })
      .toBe(WebSocket.CLOSED);
    assert(performance.now() - revoking <= 5000);
    assert.equal(
      (
        await agent.response(
          'POST',
          sessionPath(f.lab.id, active.id) + '/viewer-tickets',
          { preferred_rate_hz: 30 },
        )
      ).status,
      401,
    );
    await agentPeer.close();
    await action(page, f.lab.id, active.id, 'Pause');
    await authority(f.api, f.lab.id, active.id, 'paused');
    const pending = [];
    for (let index = 0; index < 16; index++)
      pending.push(await ticket(f.api, active));
    assert.equal(
      (
        await f.api.response(
          'POST',
          sessionPath(f.lab.id, active.id) + '/viewer-tickets',
          { preferred_rate_hz: 30 },
        )
      ).status,
      429,
    );
    const otherAccount = new CoreHttp(process.env.E2E_API_URL!);
    await otherAccount.register(
      'secure-tickets-' + randomUUID() + '@example.test',
    );
    for (let index = 0; index < 16; index++) await ticket(otherAccount, active);
    const thirdAccount = new CoreHttp(process.env.E2E_API_URL!);
    await thirdAccount.register('secure-cap-' + randomUUID() + '@example.test');
    assert.equal(
      (
        await thirdAccount.response(
          'POST',
          sessionPath(f.lab.id, active.id) + '/viewer-tickets',
          { preferred_rate_hz: 30 },
        )
      ).status,
      429,
    );
    const expiryDeadline = Date.now() + 31000;
    await expect
      .poll(() => Date.now(), { timeout: 33000, intervals: [250] })
      .toBeGreaterThanOrEqual(expiryDeadline);
    const expired = new SecurityPeer(active, pending[0]);
    await expired.denied();
    await expired.close();
    const renewed = new SecurityPeer(active, await ticket(f.api, active));
    await renewed.admitted();
    await renewed.close();
    const owner = new CoreHttp(process.env.E2E_API_URL!);
    await owner.login(
      process.env.E2E_OWNER_EMAIL!,
      process.env.E2E_OWNER_PASSWORD!,
    );
    const memberPeer = new SecurityPeer(
      active,
      await ticket(thirdAccount, active),
    );
    await memberPeer.admitted();
    const members = await owner.json<{
      data: { user_id: string; role: string; version: number }[];
    }>('GET', '/api/v1/organization/members?limit=100');
    const member = members.data.find(
      (value) => value.user_id === thirdAccount.session!.user.id,
    )!;
    assert(member);
    const deactivating = performance.now();
    await owner.json('PUT', '/api/v1/organization/members/' + member.user_id, {
      role: member.role,
      active: false,
      version: member.version,
    });
    await expect
      .poll(() => memberPeer.socket.readyState, { timeout: 5000 })
      .toBe(WebSocket.CLOSED);
    assert(performance.now() - deactivating <= 5000);
    await memberPeer.close();
    const cookiePeer = new SecurityPeer(
      active,
      await ticket(otherAccount, active),
    );
    await cookiePeer.admitted();
    const loggingOut = performance.now();
    await otherAccount.json('POST', '/api/v1/auth/logout', undefined, 204);
    await expect
      .poll(() => cookiePeer.socket.readyState, { timeout: 5000 })
      .toBe(WebSocket.CLOSED);
    assert(performance.now() - loggingOut <= 5000);
    await cookiePeer.close();
    assertSessionGeometry(await pose(f.second, active.id), active);
    const beforeRevoke = await recordingForSession(f.api, f.lab.id, active.id);
    const confirmedRead = await publicRecording(
      f.api,
      f.lab.id,
      beforeRevoke.id,
    );
    assert(
      recordedFrames(recordedSourcePackets(confirmedRead.records)).length > 1,
    );
    const revokingMachine = performance.now();
    await owner.json(
      'POST',
      '/api/v1/machines/' + active.machine_id + '/revoke',
      undefined,
      204,
    );
    await authority(f.api, f.lab.id, active.id, 'interrupted');
    const interrupted = await recordingForSession(f.api, f.lab.id, active.id);
    const sourceFences = await sourcePairClosed(
      active.id,
      interrupted.id,
      revokingMachine + 5000,
    );
    assert(performance.now() - revokingMachine <= 5000);
    await eventually(
      () =>
        f!.api.json<{ status: string }>(
          'GET',
          recordingPath(f!.lab.id, interrupted.id),
        ),
      (value) => value.status === 'incomplete',
      10000,
    );
    const incompleteRead = await publicRecording(
      f.api,
      f.lab.id,
      interrupted.id,
    );
    const incompleteBytes = assertSourceWitness(
      active.id,
      incompleteRead.records,
      false,
      recordedSourcePackets(confirmedRead.records),
    );
    receipt('secure-wss-admission', {
      negativeCases: denials.length,
      mappingLeaks: denials.reduce(
        (count, value) =>
          count + value.metadataMessages + value.unsafeCloseReasons,
        0,
      ),
      leakedBinaryBytes: denials.reduce(
        (count, value) => count + value.binaryBytes,
        0,
      ),
      denialObservations: denials,
      accountLiveCap: 8,
      accountTicketCap: 16,
      sessionTicketCap: 32,
      expirySeconds: 30,
      establishedActorAndMachineRevokeBoundMs: 5000,
      distinctCredentialsShareCap: true,
      sourceFences,
      incompleteSourceBytes: incompleteBytes,
      scope: 'local actual TLS; no WAN claim',
    });
    active = undefined;
  } finally {
    await cleanupPeers();
    await f?.secondContext.close();
  }
});

test('TLS slow reader pressure: actual encrypted TCP buffering stays bounded while the fast WebGL Viewer and reliable Recording continue', async ({
  page,
  browser,
}) => {
  test.setTimeout(210000);
  let f: Awaited<ReturnType<typeof prepareSession>> | undefined;
  let active: SimulationSession | undefined;
  const slow = new OwnedMotionActor('slow-reader');
  try {
    f = await prepareSession(page, browser);
    active = await action(page, f.lab.id, null, 'Start');
    active = await authority(f.api, f.lab.id, active.id, 'running');
    const first = await pose(f.second, active.id);
    const scoped = await ticket(f.api, active);
    await slow.start(
      'tests/support/motion-slow-reader.py',
      [
        process.env.E2E_API_URL!.replace(/^http/, 'ws') + scoped.websocket_path,
        process.env.E2E_WEB_URL!,
        active.id,
        active.snapshot.installation.scene_hash,
      ],
      scoped.ticket,
    );
    const admitted = await eventually(async () => {
      const line = slow.stdout
        .split('\n')
        .find((value) => value.includes('slow.admitted'));
      return line
        ? (JSON.parse(line) as {
            local_port: number;
            receive_buffer_bytes: number;
          })
        : undefined;
    }, Boolean);
    assert(admitted && admitted.receive_buffer_bytes <= 8192);
    let ordinaryReads = 0;
    const deadline = performance.now() + 180000;
    let pressure:
      ReturnType<typeof gatewayFacts>[number]['sockets'][number] | undefined;
    while (performance.now() < deadline) {
      pressure = gatewayFacts()
        .flatMap((value) => value.sockets)
        .find(
          (socket) =>
            socket.role === 'viewer' &&
            socket.remotePort === admitted.local_port,
        );
      if (pressure && !pressure.open && pressure.maxBufferBytes > 65536) break;
      assert.equal(
        (await f.api.response('GET', `/api/v1/lab/labs/${f.lab.id}/world`))
          .status,
        200,
      );
      ordinaryReads++;
      const next = await pose(f.second, active.id);
      assert(BigInt(next.nodes[0].sequence) >= BigInt(first.nodes[0].sequence));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert(pressure && pressure.encrypted && !pressure.open);
    assert(pressure.maxBufferBytes > 65536);
    assert.equal(pressure.closeReason, 'slow_viewer');
    assert(
      pressure.softCrossedAt !== null && pressure.closeRequestedAt !== null,
    );
    const pressureDuration = pressure.closeRequestedAt - pressure.softCrossedAt;
    // Original 2s sustained budget, the 8ms flush cadence and 250ms socket
    // closure allowance. Both timestamps use the same real server clock.
    assert(pressureDuration >= 1992 && pressureDuration <= 2258);
    const facts = gatewayFacts();
    assert(
      facts.every(
        (value) =>
          value.pendingMaxSlots <= 1 &&
          value.pendingMaxBytes <= 632 &&
          value.directPoseDbCalls === 0,
      ),
    );
    const next = await pose(f.second, active.id);
    assert(
      BigInt(next.nodes[0].sequence) > BigInt(first.nodes[0].sequence) + 100n,
    );
    assertSessionGeometry(next, active);
    assert(ordinaryReads > 1);
    const recording = await recordingForSession(f.api, f.lab.id, active.id);
    const read = await publicRecording(f.api, f.lab.id, recording.id);
    const frames = recordedFrames(recordedSourcePackets(read.records));
    assert(frames.length > 100);
    assertSessionFrame(active, readSessionFrame(frames.at(-1)!));
    await action(page, f.lab.id, active.id, 'Stop');
    await authority(f.api, f.lab.id, active.id, 'stopped');
    await eventually(
      () =>
        f!.api.json<{ status: string }>(
          'GET',
          recordingPath(f!.lab.id, recording.id),
        ),
      (value) => value.status === 'complete',
      10000,
    );
    const completeRead = await publicRecording(f.api, f.lab.id, recording.id);
    const exactSourceBytes = assertSourceWitness(
      active.id,
      completeRead.records,
      true,
    );
    receipt('secure-wss-real-pressure', {
      scope: 'local real TLS/TCP; original pressure and byte budgets',
      maxBufferBytes: pressure.maxBufferBytes,
      closeReason: pressure.closeReason,
      sustainedPressureMs: pressureDuration,
      pendingSlotsMax: Math.max(...facts.map((value) => value.pendingMaxSlots)),
      directPoseDbCalls: Math.max(
        ...facts.map((value) => value.directPoseDbCalls),
      ),
      fastFrameAdvance: String(
        BigInt(next.nodes[0].sequence) - BigInt(first.nodes[0].sequence),
      ),
      reliableFrames: frames.length,
      exactSourceBytes,
      ordinaryReads,
    });
    active = undefined;
  } finally {
    await slow.stop();
    await cleanupPeers();
    await f?.secondContext.close();
  }
});
