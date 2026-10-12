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
import {
  assertAck,
  canonicalHeader,
  capturePolicy,
  digest,
  frameBatch,
  initialPrefix,
  mappingDigest,
  nextPrefix,
  sourceHeader,
  sourcePacket,
  type RecordingIdentity,
  type SourceAck,
} from './recording-wire-oracle';

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
  private recording?: WebSocket;
  private recordingScope?: RecordingIdentity;
  private recordingLimits?: Record<string, number>;
  private recordingFailure?: string;
  private recordingWaiter?: {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };
  private recordingTimer?: ReturnType<typeof setTimeout>;
  private packetSequence = 0n;
  private eventSequence = 0n;
  private prefix = '';
  private lastAck?: SourceAck;
  private pendingReply?: string;
  private receivedControl?: { id: unknown; at: number };
  constructor(
    readonly session: SimulationSession,
    private ticket: SessionMotionTicket,
    private role: 'publisher' | 'viewer' = 'publisher',
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
        else {
          const control = JSON.parse(String(data));
          if (control.type === 'motion.session_control')
            this.receivedControl = {
              id: control.transition_id,
              at: performance.now(),
            };
          this.messages.push(control);
        }
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
          scene_hash: session.snapshot.installation.scene_hash,
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
    if (this.role === 'publisher') await this.openRecording();
  }
  private async openRecording() {
    const admission = this.ticket as PublisherAdmission;
    const bootstrap = admission.recording;
    assert(bootstrap, 'Formal publisher requires independent Recording');
    this.recordingScope = {
      recording_id: bootstrap.recording_id,
      session_id: bootstrap.session_id,
      lease_id: bootstrap.lease_id,
      epoch: bootstrap.epoch,
      snapshot_hash: bootstrap.snapshot_hash,
      manifest_sha256: bootstrap.manifest_sha256,
      scene_hash: bootstrap.scene_hash,
      mapping_revision: bootstrap.mapping_revision,
      mapping_sha256: bootstrap.mapping_sha256,
    };
    assert.equal(bootstrap.session_id, this.session.id);
    assert.equal(bootstrap.lease_id, admission.lease_id);
    assert.equal(bootstrap.epoch, this.session.epoch);
    assert.equal(bootstrap.snapshot_hash, this.session.snapshot.hash);
    assert.equal(
      bootstrap.scene_hash,
      this.session.snapshot.installation.scene_hash,
    );
    assert.equal(
      bootstrap.mapping_revision,
      this.session.snapshot.installation.mapping_revision,
    );
    assert.equal(bootstrap.mapping_sha256, mappingDigest(this.session));
    assert.deepEqual(bootstrap.capture_policy, capturePolicy);
    assert.notEqual(bootstrap.ticket, admission.ticket);
    assert.notEqual(bootstrap.websocket_path, admission.websocket_path);
    const deadline = performance.now() + 3000;
    this.recording = new WebSocket(
      process.env.E2E_API_URL!.replace(/^http/, 'ws') +
        bootstrap.websocket_path,
      { origin: process.env.E2E_WEB_URL!, maxPayload: 16384 },
    );
    ownSessionSocket(
      this.recording,
      'machine-proof-recording',
      this.session.id,
    );
    const failed = (reason: string) => {
      this.recordingFailure = reason;
      this.recordingWaiter?.reject(new Error(reason));
    };
    this.recording.on('error', () => failed('Recording socket error'));
    this.recording.on('close', () => failed('Recording socket closed'));
    this.recording.on('message', (data, binary) => {
      const raw = Array.isArray(data) ? Buffer.concat(data) : data;
      if (binary || raw.byteLength > (this.recordingLimits ? 4096 : 16384)) {
        failed('Unexpected Recording response');
        return;
      }
      const text = (
        raw instanceof ArrayBuffer ? Buffer.from(raw) : raw
      ).toString('utf8');
      if (text === this.pendingReply) return;
      if (this.lastAck && text === JSON.stringify(this.lastAck)) return;
      if (!this.recordingWaiter) {
        failed('Recording reply without an in-flight request');
        return;
      }
      this.pendingReply = text;
      this.recordingWaiter.resolve(text);
    });
    await eventually(
      async () => {
        assert.equal(this.recordingFailure, undefined);
        return this.recording!.readyState;
      },
      (state) => state === WebSocket.OPEN,
      Math.max(1, deadline - performance.now()),
    );
    const header = sourceHeader();
    this.prefix = initialPrefix(this.recordingScope, header);
    const ready = JSON.parse(
      await this.exchange(
        JSON.stringify({
          type: 'recording.hello',
          version: 1,
          codec: 'lwr1-source-v1',
          ...this.recordingScope,
          ticket: bootstrap.ticket,
          source_header: header,
        }),
        deadline,
        false,
      ),
    );
    assert.equal(ready.type, 'recording.ready');
    assert.equal(ready.version, 1);
    assert.equal(ready.codec, 'lwr1-source-v1');
    for (const [key, value] of Object.entries(this.recordingScope))
      assert.equal(ready[key], value);
    assert.equal(ready.source_header_sha256, digest(canonicalHeader(header)));
    assert.equal(ready.source_prefix_sha256, this.prefix);
    assert.deepEqual(ready.capture_policy, bootstrap.capture_policy);
    assert.deepEqual(ready.limits, bootstrap.limits);
    this.recordingLimits = bootstrap.limits;
  }
  private exchange(
    bytes: string | Buffer,
    deadline: number,
    retry = true,
  ): Promise<string> {
    assert.equal(this.recording?.readyState, WebSocket.OPEN);
    assert.equal(this.recordingWaiter, undefined);
    assert.equal(this.recordingFailure, undefined);
    assert(performance.now() < deadline, 'Recording receipt budget expired');
    this.pendingReply = undefined;
    const started = performance.now();
    const steps = retry
      ? [
          this.recordingLimits!.retry_first_ms,
          this.recordingLimits!.retry_second_ms,
        ]
      : [];
    let attempt = 0;
    return new Promise((resolve, reject) => {
      const complete = (text?: string, error?: Error) => {
        clearTimeout(this.recordingTimer);
        this.recordingTimer = undefined;
        this.recordingWaiter = undefined;
        if (error) reject(error);
        else resolve(text!);
      };
      this.recordingWaiter = {
        resolve: (text) => complete(text),
        reject: (error) => complete(undefined, error),
      };
      const schedule = () => {
        const next = Math.min(
          deadline,
          attempt < steps.length ? started + steps[attempt] : deadline,
        );
        this.recordingTimer = setTimeout(
          () => {
            if (performance.now() >= deadline || attempt === steps.length) {
              complete(
                undefined,
                new Error('Recording receipt deadline exceeded'),
              );
              return;
            }
            this.recording!.send(bytes);
            attempt++;
            schedule();
          },
          Math.max(0, next - performance.now()),
        );
      };
      this.recording!.send(bytes);
      schedule();
    });
  }
  private async capture(kind: 1 | 2 | 3, payload: Buffer, deadline: number) {
    const scope = this.recordingScope!;
    const selected = sourcePacket(
      scope,
      kind,
      this.packetSequence + 1n,
      payload,
    );
    const prefix = nextPrefix(this.prefix, selected.digest);
    const ack = JSON.parse(
      await this.exchange(selected.bytes, deadline),
    ) as SourceAck;
    assertAck(ack, scope, {
      packetSequence: this.packetSequence + 1n,
      packetHash: selected.digest,
      prefixHash: prefix,
      sourceSequence: this.sequence,
      eventSequence: this.eventSequence,
      ended: kind === 3,
    });
    this.packetSequence++;
    this.prefix = prefix;
    this.lastAck = ack;
    receipt('session-machine-recording-' + this.session.id, {
      session_id: this.session.id,
      recording_id: scope.recording_id,
      lastDurableReceipt: ack,
      selectedFrameCount: String(this.sequence),
      sourceEventCount: String(this.eventSequence),
    });
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
  private selectFrame(time: bigint, offset: number) {
    this.sequence++;
    this.time = time;
    return packet(this.session, this.sequence, time, offset);
  }
  async frame(time = 0n, offset = 0) {
    const bytes = this.selectFrame(time, offset);
    await this.capture(
      1,
      frameBatch([bytes]),
      performance.now() + this.recordingLimits!.durability_timeout_ms,
    );
    this.socket.send(bytes);
    return readSessionFrame(bytes);
  }
  private controlDeadline(control: Control) {
    assert.equal(control.transition_id, this.receivedControl?.id);
    return (
      this.receivedControl!.at + this.recordingLimits!.durability_timeout_ms
    );
  }
  private async captureAppliedClaim(control: Control, deadline: number) {
    this.eventSequence++;
    await this.capture(
      2,
      Buffer.from(
        JSON.stringify({
          source_event_sequence: String(this.eventSequence),
          event_id: randomUUID(),
          event_type: 'lifecycle.applied',
          subject: { session_id: this.session.id },
          sim_time_ns: String(this.time),
          observed_at: null,
          event: {
            transition_id: control.transition_id,
            revision: control.revision,
            action: control.action,
            boundary_source_sequence: String(this.sequence),
          },
        }),
      ),
      deadline,
    );
  }
  async apply(control: Control, time: bigint, offset = 0) {
    const deadline = this.controlDeadline(control);
    const bytes = this.selectFrame(time, offset);
    await this.capture(1, frameBatch([bytes]), deadline);
    await this.captureAppliedClaim(control, deadline);
    if (control.action === 'stop')
      await this.capture(
        3,
        Buffer.from(
          JSON.stringify({
            transition_id: control.transition_id,
            revision: control.revision,
            reason: 'stop',
            last_source_sequence: String(this.sequence),
            last_source_event_sequence: String(this.eventSequence),
            sim_time_ns: String(time),
          }),
        ),
        deadline,
      );
    this.socket.send(bytes);
    this.ack(control);
    return readSessionFrame(bytes);
  }
  async claimOldBoundary(control: Control) {
    assert(control.action === 'pause' || control.action === 'resume');
    // Hostile source claim: Recording can retain it, but it must not authorize
    // a transition without the required new boundary sequence. No live write.
    await this.captureAppliedClaim(control, this.controlDeadline(control));
  }
  // Deliberately raw: negative cases must not acquire a new durable boundary.
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
  close() {
    this.recordingWaiter?.reject(new Error('Owned source closed'));
    clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
    this.socket.terminate();
    this.recording?.terminate();
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
    const initial = await source.frame();
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
    const boundary = await f.source.apply(pause, 100_000_000n, 0.4);
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
    const anchor = await f.source.apply(resume, 100_000_000n, 0.4);
    assert(BigInt(anchor.sequence) > BigInt(boundary.sequence));
    assert.equal(anchor.sim_time_ns, boundary.sim_time_ns);
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
    const [reset, resetBoundary] = await Promise.all([
      transition(original.id, 'reset'),
      (async () => {
        const stop = await f.source.control('stop');
        return f.source.apply(stop, 200_000_000n, 0.4);
      })(),
    ]);
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
      durableStopBoundary: resetBoundary,
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
        await bound.source.apply(control, 100_000_000n, 0.4);
        await authority(api, lab.id, candidate.id, 'paused');
        await transition(candidate.id, 'resume');
        control = await bound.source.control('resume');
      }
      if (variant.startsWith('old-')) {
        await bound.source.claimOldBoundary(control);
        bound.source.ack(control);
      } else if (variant === 'malformed-pause')
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
    for (const peer of peers) peer.close();
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
