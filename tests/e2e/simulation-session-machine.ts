import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type {
  MachineCredential,
  PublisherAdmission,
  SceneInstallation,
  SessionMotionTicket,
  SimulationSession,
} from '../../packages/contracts/src/generated/types.gen';
import { CoreHttp } from '../support/core-http';
import { publishAsset } from '../support/lab-assets-http';
import {
  eventually,
  receipt,
  stage,
  sessionsPath,
  sessionPath,
  world,
  savedLayout,
  authority,
  ownSessionSocket,
  closeSessionSockets,
} from './simulation-session-support';
import {
  readSessionFrame,
  type SessionFrame,
} from './simulation-session-oracle';

// Independently write the published 48-byte header and 584-byte pose-f32-v1
// payload. The proof never imports the production encoder or authority cache.
function packet(
  session: SimulationSession,
  sequence: bigint,
  time: bigint,
  offset: number,
) {
  assert(session.epoch);
  const value = Buffer.alloc(632);
  value.write('LWM1', 0, 'ascii');
  value[4] = 1;
  value[5] = 1;
  value.writeBigUInt64LE(BigInt(session.epoch), 8);
  value.writeBigUInt64LE(sequence, 16);
  value.writeBigUInt64LE(time, 24);
  value.writeUInt32LE(session.snapshot.installation.mapping_revision, 32);
  value.writeUInt32LE(20, 36);
  value.writeUInt32LE(6, 40);
  value.writeUInt32LE(584, 44);
  session.snapshot.initial_poses.forEach((pose, i) => {
    pose.position.forEach((component, axis) =>
      value.writeFloatLE(
        component + (axis === 0 ? offset : 0),
        48 + i * 28 + axis * 4,
      ),
    );
    pose.quaternion.forEach((component, axis) =>
      value.writeFloatLE(component, 60 + i * 28 + axis * 4),
    );
  });
  session.snapshot.initial_joints.forEach((component, i) =>
    value.writeFloatLE(component, 608 + i * 4),
  );
  return value;
}

type Control = Record<string, unknown>;
class Peer {
  readonly socket: WebSocket;
  readonly messages: Control[] = [];
  latest?: SessionFrame;
  sequence = 0n;
  time = 0n;
  failure?: string;
  constructor(
    readonly session: SimulationSession,
    ticket: SessionMotionTicket,
    role: 'publisher' | 'viewer' = 'publisher',
  ) {
    this.socket = new WebSocket(
      process.env.E2E_API_URL!.replace(/^http/, 'ws') + ticket.websocket_path,
      { origin: process.env.E2E_WEB_URL! },
    );
    ownSessionSocket(this.socket, 'machine-proof-' + role, session.id);
    this.socket.on('error', (error) => {
      this.failure = error.name;
    });
    this.socket.on('message', (data, binary) => {
      try {
        if (binary)
          this.latest = readSessionFrame(Buffer.from(data as Uint8Array));
        else this.messages.push(JSON.parse(String(data)));
      } catch (error) {
        this.failure = error instanceof Error ? error.name : 'WireError';
      }
    });
    this.socket.once('open', () =>
      this.socket.send(
        JSON.stringify({
          type: 'motion.hello',
          version: 1,
          codec: 'pose-f32-v1',
          role,
          session_id: session.id,
          ticket: ticket.ticket,
          preferred_rate_hz: 30,
          ...(role === 'publisher'
            ? { scene_hash: session.snapshot.installation.scene_hash }
            : {}),
        }),
      ),
    );
  }
  async message(type: string) {
    return eventually(
      async () => {
        assert.equal(this.failure, undefined);
        return this.messages.find((item) => item.type === type);
      },
      Boolean,
      5000,
    ).then((value) => value!);
  }
  async ready() {
    const welcome = await this.message('motion.welcome');
    assert.equal(welcome.session_id, this.session.id);
    assert.equal(
      welcome.scene_hash,
      this.session.snapshot.installation.scene_hash,
    );
    assert.equal(welcome.epoch, this.session.epoch);
    assert.deepEqual(
      welcome.pose_keys,
      this.session.snapshot.installation.pose_keys,
    );
    assert.deepEqual(
      welcome.joint_keys,
      this.session.snapshot.installation.joint_keys,
    );
  }
  async control(action: string) {
    return eventually(
      async () =>
        this.messages.find(
          (item) =>
            item.type === 'motion.session_control' && item.action === action,
        ),
      Boolean,
      5000,
    ).then((value) => {
      assert(value);
      assert.equal(value.session_id, this.session.id);
      assert.equal(value.epoch, this.session.epoch);
      return value;
    });
  }
  frame(time = 0n, offset = 0) {
    this.sequence++;
    this.time = time;
    const bytes = packet(this.session, this.sequence, time, offset);
    this.socket.send(bytes);
    return readSessionFrame(bytes);
  }
  ack(control: Control) {
    this.socket.send(
      JSON.stringify({
        ...control,
        type: 'motion.session_ack',
        result: 'applied',
        last_sequence: String(this.sequence),
        sim_time_ns: String(this.time),
      }),
    );
  }
  async rejected() {
    const error = await this.message('motion.error');
    assert.equal(error.code, 'unauthorized');
    assert(!this.messages.some((item) => item.type === 'motion.welcome'));
    await eventually(
      async () => this.socket.readyState,
      (value) => value === WebSocket.CLOSED,
      5000,
    );
    return { type: error.type, code: error.code, closed: true };
  }
}

export async function verifyMachineAuthority() {
  stage('session-public-machine-proof-start');
  const api = new CoreHttp(process.env.E2E_API_URL!);
  await api.register(`session-machine-${randomUUID()}@example.test`);
  const lab = await api.json<{ id: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Independent public machine authority' },
    201,
  );
  const asset = await publishAsset(
    api,
    readFileSync('tests/fixtures/lab/cube.glb'),
    'Machine protocol public GLB',
  );
  const installation = await api.json<SceneInstallation>(
    'POST',
    `/api/v1/lab/labs/${lab.id}/installations`,
    { representation_id: asset.representation.id },
    201,
  );
  const machine = await api.json<MachineCredential>(
    'POST',
    '/api/v1/machines',
    { name: 'Independent public source' },
    201,
  );
  const wrong = await api.json<MachineCredential>(
    'POST',
    '/api/v1/machines',
    { name: 'Wrong independently provisioned source' },
    201,
  );
  const sourceApi = new CoreHttp(process.env.E2E_API_URL!, {
    authorization: 'Bearer ' + machine.credential,
  });
  const wrongApi = new CoreHttp(process.env.E2E_API_URL!, {
    authorization: 'Bearer ' + wrong.credential,
  });
  const peers: Peer[] = [],
    records: unknown[] = [];
  let cleanupFailures: unknown[];
  const read = (id: string) =>
    api.json<SimulationSession>('GET', sessionPath(lab.id, id));
  const start = () =>
    api.json<SimulationSession>(
      'POST',
      sessionsPath(lab.id),
      { installation_id: installation.id, machine_id: machine.machine.id },
      201,
    );
  const admit = (session: SimulationSession) =>
    sourceApi.json<PublisherAdmission>(
      'POST',
      `${sessionPath(lab.id, session.id)}/publisher-admissions`,
      { machine_id: machine.machine.id },
      201,
    );
  const transition = async (id: string, action: string) => {
    const current = await read(id);
    return api.json<SimulationSession>(
      'POST',
      `${sessionPath(lab.id, id)}/${action}`,
      { expected_revision: current.revision },
    );
  };
  const ownedPeer = (
    session: SimulationSession,
    ticket: SessionMotionTicket,
    role: 'publisher' | 'viewer' = 'publisher',
  ) => {
    const peer = new Peer(session, ticket, role);
    peers.push(peer);
    return peer;
  };
  const bind = async (session: SimulationSession) => {
    const admission = await admit(session),
      scoped = await read(session.id);
    assert.equal(scoped.lease_id, admission.lease_id);
    assert.equal(scoped.epoch, admission.epoch);
    assert.deepEqual(admission.bootstrap, {
      snapshot_hash: session.snapshot.hash,
      session_id: session.id,
      scene_hash: session.snapshot.installation.scene_hash,
      body_order: session.snapshot.installation.pose_keys,
      joint_order: session.snapshot.installation.joint_keys,
      initial_poses: session.snapshot.initial_poses,
      initial_joints: session.snapshot.initial_joints,
      parameters: session.snapshot.parameters,
    });
    await sourceApi.error(
      'POST',
      `${sessionPath(lab.id, session.id)}/publisher-admissions`,
      { machine_id: machine.machine.id },
      409,
      'lab.publisher_conflict',
    );
    const source = ownedPeer(scoped, admission);
    await source.ready();
    const initial = source.frame();
    assert.equal(initial.sim_time_ns, '0');
    const running = await authority(api, lab.id, session.id, 'running');
    records.push({
      phase: 'initial-admission',
      id: session.id,
      lease: admission.lease_id,
      epoch: admission.epoch,
      snapshotHash: admission.bootstrap.snapshot_hash,
      initial,
    });
    return { admission, scoped, source, running };
  };
  try {
    const original = await start(),
      path = `${sessionPath(lab.id, original.id)}/publisher-admissions`;
    assert.equal(original.status, 'starting');
    assert.equal(original.lease_id, null);
    await api.error(
      'POST',
      path,
      { machine_id: machine.machine.id },
      403,
      'identity.machine_unauthorized',
    );
    await sourceApi.error(
      'POST',
      path,
      { machine_id: api.session!.user.id },
      403,
      'identity.machine_unauthorized',
    );
    await wrongApi.error(
      'POST',
      path,
      { machine_id: wrong.machine.id },
      403,
      'lab.publisher_unauthorized',
    );
    const saved = await world(api, lab.id);
    saved.nodes[0].placement.position[0] += 1.5;
    await savedLayout(api, lab.id, saved);
    const f = await bind(original);
    assert.notDeepEqual(
      (await world(api, lab.id)).nodes,
      original.snapshot.world.nodes,
    );
    await sourceApi.error(
      'POST',
      path,
      { machine_id: machine.machine.id },
      403,
      'lab.publisher_unauthorized',
    );
    const replay = ownedPeer(f.scoped, f.admission);
    records.push({
      phase: 'ticket-reuse-denied',
      ...(await replay.rejected()),
    });
    assert.equal((await read(original.id)).lease_id, f.admission.lease_id);
    const viewerTicket = await api.json<SessionMotionTicket>(
      'POST',
      `${sessionPath(lab.id, original.id)}/viewer-tickets`,
      { preferred_rate_hz: 30 },
      201,
    );
    const viewer = ownedPeer(f.scoped, viewerTicket, 'viewer');
    await viewer.ready();
    await transition(original.id, 'pause');
    const pause = await f.source.control('pause');
    const boundary = f.source.frame(100_000_000n, 0.4);
    f.source.ack(pause);
    await authority(api, lab.id, original.id, 'paused');
    await eventually(
      async () => viewer.latest,
      (frame) => frame?.sequence === boundary.sequence,
    );
    assert.deepEqual(viewer.latest, boundary);
    await viewer.message('motion.status');
    await eventually(
      async () => viewer.messages,
      (messages) =>
        messages.some(
          (message) =>
            message.type === 'motion.status' && message.state === 'paused',
        ),
    );
    // Keep the valid source paused while provisioning the second scope, so
    // this setup cannot accidentally exercise the running progress deadline.
    const crossLab = await api.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Machine cross Session scope' },
      201,
    );
    const crossInstall = await api.json<SceneInstallation>(
      'POST',
      `/api/v1/lab/labs/${crossLab.id}/installations`,
      { representation_id: asset.representation.id },
      201,
    );
    const crossSession = await api.json<SimulationSession>(
      'POST',
      sessionsPath(crossLab.id),
      { installation_id: crossInstall.id, machine_id: machine.machine.id },
      201,
    );
    const crossAdmission = await sourceApi.json<PublisherAdmission>(
      'POST',
      `${sessionPath(crossLab.id, crossSession.id)}/publisher-admissions`,
      { machine_id: machine.machine.id },
      201,
    );
    assert.notEqual(crossAdmission.epoch, f.admission.epoch);
    assert.notEqual(crossAdmission.lease_id, f.admission.lease_id);
    const cross = ownedPeer(f.scoped, {
      ...crossAdmission,
      websocket_path: f.admission.websocket_path,
    });
    records.push({
      phase: 'cross-session-ticket-denied',
      ...(await cross.rejected()),
    });
    const crossCurrent = await api.json<SimulationSession>(
      'GET',
      sessionPath(crossLab.id, crossSession.id),
    );
    await api.json(
      'POST',
      `${sessionPath(crossLab.id, crossSession.id)}/stop`,
      { expected_revision: crossCurrent.revision },
    );
    await authority(api, crossLab.id, crossSession.id, 'interrupted');
    await transition(original.id, 'resume');
    const resume = await f.source.control('resume');
    const anchor = f.source.frame(100_000_000n, 0.4);
    assert(BigInt(anchor.sequence) > BigInt(boundary.sequence));
    assert.equal(anchor.sim_time_ns, boundary.sim_time_ns);
    f.source.ack(resume);
    await authority(api, lab.id, original.id, 'running');
    records.push({
      phase: 'valid-new-sequence-same-time-resume',
      boundary,
      anchor,
    });
    const oldViewerTicket = await api.json<SessionMotionTicket>(
      'POST',
      `${sessionPath(lab.id, original.id)}/viewer-tickets`,
      { preferred_rate_hz: 30 },
      201,
    );
    const reset = await transition(original.id, 'reset');
    assert.notEqual(reset.id, original.id);
    assert.deepEqual(reset.snapshot, original.snapshot);
    await eventually(
      async () => f.source.socket.readyState,
      (value) => value === WebSocket.CLOSED,
    );
    await eventually(
      async () => viewer.socket.readyState,
      (value) => value === WebSocket.CLOSED,
    );
    await sourceApi.error(
      'POST',
      path,
      { machine_id: machine.machine.id },
      403,
      'lab.publisher_unauthorized',
    );
    records.push({
      phase: 'reset-old-scope-fenced',
      ...(await ownedPeer(f.scoped, oldViewerTicket, 'viewer').rejected()),
    });
    let candidate = reset;
    for (const variant of [
      'old-pause',
      'old-resume',
      'missing-pause',
      'malformed-pause',
    ]) {
      const bound = await bind(candidate);
      assert.notEqual(bound.admission.epoch, f.admission.epoch);
      assert.notEqual(bound.admission.lease_id, f.admission.lease_id);
      await transition(candidate.id, 'pause');
      let control = await bound.source.control('pause');
      if (variant === 'old-resume') {
        bound.source.frame(100_000_000n, 0.4);
        bound.source.ack(control);
        await authority(api, lab.id, candidate.id, 'paused');
        await transition(candidate.id, 'resume');
        control = await bound.source.control('resume');
      }
      if (variant.startsWith('old-')) bound.source.ack(control);
      else if (variant === 'malformed-pause')
        bound.source.socket.send(
          JSON.stringify({
            ...control,
            type: 'motion.session_ack',
            result: 'applied',
            sim_time_ns: '0',
          }),
        );
      if (variant !== 'missing-pause')
        assert.equal(
          (await bound.source.message('motion.error')).code,
          'invalid_message',
        );
      const pending = await read(candidate.id);
      assert.notEqual(
        pending.status,
        variant === 'old-resume' ? 'running' : 'paused',
      );
      const interrupted = await authority(
        api,
        lab.id,
        candidate.id,
        'interrupted',
      );
      assert.equal(interrupted.reason, 'source_ack_timeout');
      records.push({
        phase: variant + '-fail-closed',
        id: candidate.id,
        pending: pending.status,
        terminal: interrupted.status,
        reason: interrupted.reason,
      });
      receipt('session-public-machine-authority', records);
      candidate = await start();
    }
    const revoked = await bind(candidate);
    await api.json(
      'POST',
      `/api/v1/machines/${machine.machine.id}/revoke`,
      undefined,
      204,
    );
    const ended = await authority(api, lab.id, candidate.id, 'interrupted');
    assert.equal(ended.reason, 'machine_revoked');
    await eventually(
      async () => revoked.source.socket.readyState,
      (value) => value === WebSocket.CLOSED,
    );
    await sourceApi.error(
      'POST',
      `${sessionPath(lab.id, candidate.id)}/publisher-admissions`,
      { machine_id: machine.machine.id },
      403,
      'identity.machine_unauthorized',
    );
    assert.equal(
      (await api.json<{ active_session_id: null }>('GET', sessionsPath(lab.id)))
        .active_session_id,
      null,
    );
    records.push({
      phase: 'machine-revocation-fences-live-source',
      id: candidate.id,
      reason: ended.reason,
      expiresAt: machine.machine.expires_at,
      publicExpiryNotManipulated: true,
    });
    receipt('session-public-machine-authority', records);
    stage('session-public-machine-proof-pass');
  } catch (error) {
    stage('session-public-machine-proof-error', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  } finally {
    const results = await Promise.allSettled([
      closeSessionSockets(),
      api.json(
        'POST',
        `/api/v1/machines/${machine.machine.id}/revoke`,
        undefined,
        204,
      ),
      api.json(
        'POST',
        `/api/v1/machines/${wrong.machine.id}/revoke`,
        undefined,
        204,
      ),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    cleanupFailures = failures.map(
      (result) => result.status === 'rejected' && result.reason,
    );
    stage('session-public-machine-owned-consumers-closed', {
      peers: peers.length,
      cleanupFailures: failures.map(
        (result) =>
          result.status === 'rejected' &&
          (result.reason instanceof Error
            ? result.reason.name
            : 'CleanupError'),
      ),
    });
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      cleanupFailures,
      'Machine proof owned-consumer cleanup failed',
    );
}
