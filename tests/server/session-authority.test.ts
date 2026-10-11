import { Database } from '../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
import {
  encodeMotionSnapshot,
  decodeMotionSnapshot,
  parseMotionWelcome,
  parseMotionSessionControl,
  type MotionWelcome,
} from '../../packages/contracts/src/motion/index.ts';
import {
  RECORDING_CAPTURE_POLICY,
  RECORDING_CODEC,
  RECORDING_IDENTITY_FIELDS,
  parseRecordingBootstrap,
  parseRecordingReady,
  parseRecordingAck,
  canonicalSourceHeader,
  recordingSHA256,
  mappingDigest,
  sourcePrefixSeed,
  advanceSourcePrefix,
  encodeRecordingPacket,
  decodeRecordingPacket,
  encodeFrameBatch,
  type RecordingBootstrap,
  type RecordingReady,
  type RecordingAck,
  type RecordingSourceHeader,
} from '../../packages/contracts/src/recording/index.ts';
import type {
  Session,
  Installation,
} from '../../packages/server/src/lab/sessions/dto.ts';
type Admission = {
  ticket: string;
  websocket_path: string;
  lease_id: string;
  epoch: string;
  recording?: RecordingBootstrap;
  bootstrap: {
    snapshot_hash: string;
    initial_poses: Session['snapshot']['initial_poses'];
  };
};
class Source {
  readonly session: Session;
  ws: WebSocket;
  controls: Record<string, unknown>[] = [];
  frames: Uint8Array[] = [];
  welcome?: MotionWelcome;
  sequence = 0n;
  failure?: string;
  private admission: Admission;
  private role: 'viewer' | 'publisher';
  private target: ServerProcess;
  private ownership: Promise<void>;
  private recording?: WebSocket;
  private recordingReady?: RecordingReady;
  private recordingFailure?: string;
  private recordingWaiter?: {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };
  private recordingTimer?: ReturnType<typeof setTimeout>;
  private packetSequence = 0n;
  private eventSequence = 0n;
  private prefix = '';
  private lastAck?: RecordingAck;
  private pendingReply?: string;
  private receivedControl?: { id: unknown; at: number };
  constructor(
    target: ServerProcess,
    session: Session,
    admission: Admission,
    role: 'viewer' | 'publisher' = 'publisher',
  ) {
    this.session = session;
    this.admission = admission;
    this.role = role;
    this.target = target;
    this.ownership = target.startInProcess(
      `session-authority:${session.id}:${role}:${randomUUID()}`,
      async () => {},
      async () => {
        const sockets = [this.ws, this.recording].filter(
          (socket): socket is WebSocket => !!socket,
        );
        const closed = sockets.map((socket) =>
          socket.readyState === WebSocket.CLOSED
            ? Promise.resolve()
            : new Promise<void>((resolve) =>
                socket.once('close', () => resolve()),
              ),
        );
        this.close();
        await Promise.all(closed);
      },
    );
    void this.ownership.catch((error) => {
      this.failure = String(error);
      this.close();
    });
    this.ws = new WebSocket(
      target.url.replace('http:', 'ws:') + admission.websocket_path,
      { origin: target.url },
    );
    this.ws.on('error', (error) => {
      this.failure = error.message;
    });
    this.ws.on('close', (_code, reason) => {
      this.failure ??= reason.toString() || 'connection_closed';
    });
    this.ws.on('message', (data, binary) => {
      if (binary) this.frames.push(new Uint8Array(data as Buffer));
      else {
        const control = JSON.parse(String(data));
        if (control.type === 'motion.session_control')
          this.receivedControl = {
            id: control.transition_id,
            at: performance.now(),
          };
        this.controls.push(control);
      }
    });
    this.ws.once('open', () =>
      this.ws.send(
        JSON.stringify({
          type: 'motion.hello',
          version: 1,
          codec: 'pose-f32-v1',
          role,
          session_id: session.id,
          ticket: admission.ticket,
          preferred_rate_hz: 30,
          ...(role === 'publisher'
            ? { scene_hash: session.snapshot.installation.scene_hash }
            : {}),
        }),
      ),
    );
  }
  async ready() {
    await this.ownership;
    this.welcome = parseMotionWelcome(
      JSON.stringify(
        await until(
          async () => {
            if (this.failure) throw new Error(this.failure);
            return (
              this.controls.find((c) => c.type === 'motion.welcome') ??
              this.controls.find((c) => c.type === 'motion.error')
            );
          },
          Boolean,
          5000,
        ),
      ),
    );
    if (this.role === 'publisher') await this.openRecording();
    return this.welcome;
  }
  private async openRecording() {
    const bootstrap = parseRecordingBootstrap(this.admission.recording);
    assert.equal(bootstrap.session_id, this.session.id);
    assert.equal(bootstrap.lease_id, this.admission.lease_id);
    assert.equal(bootstrap.epoch, this.welcome!.epoch);
    assert.equal(bootstrap.snapshot_hash, this.session.snapshot.hash);
    assert.equal(bootstrap.scene_hash, this.welcome!.scene_hash);
    assert.equal(bootstrap.mapping_revision, this.welcome!.mapping_revision);
    assert.equal(bootstrap.mapping_sha256, await mappingDigest(this.welcome!));
    const header: RecordingSourceHeader = {
      source_kind: 'synthetic',
      implementation: {
        name: 'session-authority-test',
        version: '1',
        sha256: null,
      },
      python_version: null,
      dependencies: [],
      capture_policy: RECORDING_CAPTURE_POLICY,
    };
    this.recording = new WebSocket(
      this.target.url.replace('http:', 'ws:') + bootstrap.websocket_path,
      { origin: this.target.url, maxPayload: 16384 },
    );
    const failed = (reason: string) => {
      this.recordingFailure = reason;
      this.recordingWaiter?.reject(new Error(reason));
    };
    this.recording.on('error', () => failed('Recording socket error'));
    this.recording.on('close', () => failed('Recording socket closed'));
    this.recording.on('message', (data, binary) => {
      const raw = Array.isArray(data) ? Buffer.concat(data) : data;
      if (binary || raw.byteLength > (this.recordingReady ? 4096 : 16384)) {
        failed('Unexpected Recording response');
        return;
      }
      const text = (
        raw instanceof ArrayBuffer ? Buffer.from(raw) : raw
      ).toString('utf8');
      if (text === this.pendingReply) return;
      if (this.lastAck) {
        try {
          if (
            JSON.stringify(parseRecordingAck(text)) ===
            JSON.stringify(this.lastAck)
          )
            return;
        } catch {
          /* the current waiter checks its own message */
        }
      }
      if (!this.recordingWaiter) {
        failed('Recording reply without an in-flight request');
        return;
      }
      this.pendingReply = text;
      this.recordingWaiter.resolve(text);
    });
    await until(
      async () => {
        if (this.recordingFailure) throw new Error(this.recordingFailure);
        return this.recording!.readyState === WebSocket.OPEN;
      },
      Boolean,
      3000,
    );
    const identity = Object.fromEntries(
      RECORDING_IDENTITY_FIELDS.map((key) => [key, bootstrap[key]]),
    );
    const ready = parseRecordingReady(
      await this.exchange(
        JSON.stringify({
          type: 'recording.hello',
          version: 1,
          codec: RECORDING_CODEC,
          ...identity,
          ticket: bootstrap.ticket,
          source_header: header,
        }),
        performance.now() + 3000,
        false,
      ),
    );
    for (const key of RECORDING_IDENTITY_FIELDS)
      assert.equal(ready[key], bootstrap[key]);
    assert.deepEqual(ready.capture_policy, bootstrap.capture_policy);
    assert.deepEqual(ready.limits, bootstrap.limits);
    assert.equal(
      ready.source_header_sha256,
      await recordingSHA256(canonicalSourceHeader(header)),
    );
    assert.equal(
      ready.source_prefix_sha256,
      await sourcePrefixSeed(bootstrap, ready.source_header_sha256),
    );
    this.recordingReady = ready;
    this.prefix = ready.source_prefix_sha256;
  }
  private exchange(
    data: string | Uint8Array,
    deadline: number,
    retry = true,
  ): Promise<string> {
    assert.ok(this.recording && this.recording.readyState === WebSocket.OPEN);
    assert.equal(
      this.recordingWaiter,
      undefined,
      'Only one reliable packet may be in flight',
    );
    assert.equal(this.recordingFailure, undefined);
    assert.ok(
      performance.now() < deadline,
      'Recording total receipt deadline already expired',
    );
    this.pendingReply = undefined;
    const started = performance.now(),
      limits = this.recordingReady?.limits;
    const steps = retry
      ? [limits!.retry_first_ms, limits!.retry_second_ms]
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
            this.recording!.send(data);
            attempt++;
            schedule();
          },
          Math.max(0, next - performance.now()),
        );
      };
      this.recording!.send(data);
      schedule();
    });
  }
  private selectFrame(time: bigint, offset: number) {
    this.sequence += 1n;
    return encodeMotionSnapshot({
      epoch: BigInt(this.welcome!.epoch),
      sequence: this.sequence,
      sim_time_ns: time,
      mapping_revision: this.welcome!.mapping_revision,
      poses: this.session.snapshot.initial_poses.map((p) => ({
        position: [p.position[0] + offset, p.position[1], p.position[2]],
        quaternion: p.quaternion as [number, number, number, number],
      })),
      joints: this.session.snapshot.initial_joints,
    });
  }
  private async capture(
    kind: 1 | 2 | 3,
    payload: Uint8Array,
    deadline: number,
  ) {
    const ready = this.recordingReady!;
    const packet = await encodeRecordingPacket({
      kind,
      recording_id: ready.recording_id,
      session_id: this.session.id,
      epoch: BigInt(ready.epoch),
      source_packet_sequence: this.packetSequence + 1n,
      payload,
    });
    const decoded = await decodeRecordingPacket(packet, ready);
    const prefix = await advanceSourcePrefix(
      this.prefix,
      decoded.packet_sha256,
    );
    const ack = parseRecordingAck(await this.exchange(packet, deadline));
    assert.deepEqual(ack, {
      type: 'recording.ack',
      version: 1,
      recording_id: ready.recording_id,
      session_id: this.session.id,
      lease_id: ready.lease_id,
      epoch: ready.epoch,
      source_packet_sequence: String(this.packetSequence + 1n),
      packet_sha256: decoded.packet_sha256,
      source_prefix_sha256: prefix,
      durable_source_sequence: String(this.sequence),
      durable_source_event_sequence: String(this.eventSequence),
      source_ended: kind === 3,
    });
    this.prefix = prefix;
    this.packetSequence++;
    this.lastAck = ack;
  }
  async frame(time: bigint = 0n, offset = 0) {
    const value = this.selectFrame(time, offset);
    await this.capture(
      1,
      encodeFrameBatch([value]),
      performance.now() + this.recordingReady!.limits.durability_timeout_ms,
    );
    this.ws.send(value);
    return value;
  }
  async apply(control: Record<string, unknown>, time: bigint, offset = 0) {
    const request = parseMotionSessionControl(JSON.stringify(control));
    assert.equal(request.transition_id, this.receivedControl?.id);
    const deadline =
      this.receivedControl!.at +
      this.recordingReady!.limits.durability_timeout_ms;
    const value = this.selectFrame(time, offset);
    await this.capture(1, encodeFrameBatch([value]), deadline);
    this.eventSequence++;
    const json = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value));
    await this.capture(
      2,
      json({
        source_event_sequence: String(this.eventSequence),
        event_id: randomUUID(),
        event_type: 'lifecycle.applied',
        subject: { session_id: this.session.id },
        sim_time_ns: String(time),
        observed_at: null,
        event: {
          transition_id: request.transition_id,
          revision: request.revision,
          action: request.action,
          boundary_source_sequence: String(this.sequence),
        },
      }),
      deadline,
    );
    if (request.action === 'stop')
      await this.capture(
        3,
        json({
          transition_id: request.transition_id,
          revision: request.revision,
          reason: 'stop',
          last_source_sequence: String(this.sequence),
          last_source_event_sequence: String(this.eventSequence),
          sim_time_ns: String(time),
        }),
        deadline,
      );
    this.ws.send(value);
    this.ack(control, time);
    return value;
  }
  async control(action: string) {
    const control = await until<Record<string, unknown> | undefined>(
      async () =>
        [...this.controls]
          .reverse()
          .find(
            (c) => c.type === 'motion.session_control' && c.action === action,
          ),
      Boolean,
    );
    assert.ok(control);
    return control;
  }
  ack(
    control: Record<string, unknown>,
    time: bigint,
    sequence = this.sequence,
  ) {
    this.ws.send(
      JSON.stringify({
        ...control,
        type: 'motion.session_ack',
        result: 'applied',
        last_sequence: String(sequence),
        sim_time_ns: String(time),
      }),
    );
  }
  close() {
    this.recordingWaiter?.reject(new Error('Owned source closed'));
    clearTimeout(this.recordingTimer);
    this.recordingTimer = undefined;
    this.ws.terminate();
    this.recording?.terminate();
  }
  disconnectMotion() {
    this.ws.terminate();
  }
}
async function fixture(name: string, grace = 60000) {
  const target = await new ServerProcess().create();
  target.env = {
    APP_ORIGIN: target.url,
    FILE_PUBLIC_ORIGIN: target.url,
    LAB_WORD_SYNTHETIC_SESSION: 'true',
    LAB_WORD_SYNTHETIC_PYTHON: 'unavailable-python-for-public-test',
    LAB_WORD_MOTION_GRACE_MS: String(grace),
    LAB_WORD_MOTION_ACK_MS: '1000',
    RATE_LIMIT_ENABLED: 'false',
  };
  await target.start();
  const client = new CoreHttp(target.url);
  await client.register(name + '@example.test');
  const lab = await client.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name },
      201,
    ),
    base = `/api/v1/lab/labs/${lab.id}`;
  const asset = await publishAsset(
    client,
    await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
  );
  const installation = await client.json<Installation>(
    'POST',
    base + '/installations',
    { representation_id: asset.representation.id },
    201,
  );
  const machine = await client.json<{
    machine: { id: string };
    credential: string;
  }>('POST', '/api/v1/machines', { name: 'Independent source' }, 201);
  const sourceClient = new CoreHttp(target.url, {
    authorization: 'Bearer ' + machine.credential,
  });
  async function start() {
    return client.json<Session>(
      'POST',
      base + '/sessions',
      { installation_id: installation.id, machine_id: machine.machine.id },
      201,
    );
  }
  async function admit(session: Session) {
    return sourceClient.json<Admission>(
      'POST',
      base + `/sessions/${session.id}/publisher-admissions`,
      { machine_id: machine.machine.id },
      201,
    );
  }
  async function read(session: Session) {
    return client.json<Session>('GET', base + `/sessions/${session.id}`);
  }
  async function state(session: Session, status: string) {
    return until(
      () => read(session),
      (value) => value.status === status,
      10000,
    );
  }
  return {
    asset,
    target,
    client,
    base,
    installation,
    machine,
    sourceClient,
    start,
    admit,
    read,
    state,
  };
}

test(
  'public Session permission/conflict, immutable Reset vs latest Start, structural ownership and persistence',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-snapshot'),
      peers: Source[] = [];
    try {
      const other = await f.client.json<{ id: string }>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Other Lab' },
        201,
      );
      await f.client.error(
        'POST',
        `/api/v1/lab/labs/${other.id}/sessions`,
        {
          installation_id: f.installation.id,
          machine_id: f.machine.machine.id,
        },
        404,
        'lab.installation_not_found',
      );
      await new CoreHttp(f.target.url).error(
        'POST',
        f.base + '/sessions',
        { installation_id: f.installation.id },
        401,
        'auth.unauthorized',
      );
      const csrf = f.client.csrf;
      f.client.csrf = undefined;
      await f.client.error(
        'POST',
        f.base + '/sessions',
        { installation_id: f.installation.id },
        403,
        'auth.csrf',
      );
      f.client.csrf = csrf;
      const before = await f.client.json<Session['snapshot']['world']>(
        'GET',
        f.base + '/world',
      );
      const nodeId = f.installation.targets[0].node_id;
      const nodes = before.nodes.map(
        ({ id, entity_id, representation_id, placement }) => {
          const node = { id, entity_id, representation_id, placement };
          return {
            ...node,
            placement:
              node.id === nodeId
                ? { ...node.placement, position: [5, 0.65, -2.1] }
                : node.placement,
          };
        },
      );
      await f.client.json('PUT', f.base + '/layout', {
        expected_version: before.lab.layout_version,
        nodes,
      });
      const starts = await Promise.all([
        f.client.response('POST', f.base + '/sessions', {
          installation_id: f.installation.id,
          machine_id: f.machine.machine.id,
        }),
        f.client.response('POST', f.base + '/sessions', {
          installation_id: f.installation.id,
          machine_id: f.machine.machine.id,
        }),
      ]);
      assert.deepEqual(starts.map((r) => r.status).sort(), [201, 409]);
      const session = (await starts
        .find((r) => r.status === 201)!
        .json()) as Session;
      assert.deepEqual(
        session.snapshot.initial_poses[0].position,
        [5, 0.65, -2.1],
      );
      const source = new Source(f.target, session, await f.admit(session));
      peers.push(source);
      await source.ready();
      await source.frame();
      await f.state(session, 'running');
      const world = await f.client.json<Session['snapshot']['world']>(
        'GET',
        f.base + '/world',
      );
      const changed = world.nodes.map(
        ({ id, entity_id, representation_id, placement }) => {
          const node = { id, entity_id, representation_id, placement };
          return {
            ...node,
            placement:
              node.id === nodeId
                ? { ...node.placement, position: [7, 0.65, -2.1] }
                : node.placement,
          };
        },
      );
      await f.client.json('PUT', f.base + '/layout', {
        expected_version: world.lab.layout_version,
        nodes: changed,
      });
      const latest = await f.client.json<Session['snapshot']['world']>(
        'GET',
        f.base + '/world',
      );
      await f.client.error(
        'PUT',
        f.base + '/layout',
        {
          expected_version: latest.lab.layout_version,
          nodes: changed.filter((n) => n.id !== nodeId),
        },
        409,
        'lab.session_in_use',
      );
      await f.client.error(
        'POST',
        f.base + `/entities/${f.installation.targets[0].entity_id}/archive`,
        undefined,
        409,
        'lab.entity_in_use',
      );
      assert.deepEqual(await f.client.json('GET', f.base + '/world'), latest);
      const running = await f.read(session);
      const resetting = f.client.json<Session>(
        'POST',
        f.base + `/sessions/${session.id}/reset`,
        { expected_revision: running.revision },
      );
      const [reset] = await Promise.all([
        resetting,
        (async () => {
          // Reset owns this Stop; finish the old durable frontier before its successor.
          const internalStop = await source.control('stop');
          await source.apply(internalStop, 0n);
        })(),
      ]);
      assert.notEqual(reset.id, session.id);
      assert.deepEqual(reset.snapshot, session.snapshot);
      assert.deepEqual(
        reset.snapshot.initial_poses[0].position,
        [5, 0.65, -2.1],
      );
      assert.equal((await f.read(session)).status, 'reset');
      assert.deepEqual(await f.client.json('GET', f.base + '/world'), latest);
      const successor = new Source(f.target, reset, await f.admit(reset));
      peers.push(successor);
      await successor.ready();
      await successor.frame();
      const resumed = await f.state(reset, 'running');
      await f.client.json('POST', f.base + `/sessions/${reset.id}/stop`, {
        expected_revision: resumed.revision,
      });
      const stop = await successor.control('stop');
      await successor.apply(stop, 0n);
      await f.state(reset, 'stopped');
      const next = await f.start();
      assert.deepEqual(
        next.snapshot.initial_poses[0].position,
        [7, 0.65, -2.1],
      );
      assert.notEqual(next.snapshot.hash, session.snapshot.hash);
      peers.forEach((p) => p.close());
      const killed = once(f.target.child!, 'exit');
      f.target.child!.kill('SIGKILL');
      await killed;
      await f.target.stop();
      await f.target.start();
      await f.client.login('session-snapshot@example.test');
      const persisted = await f.read(next);
      assert.equal(persisted.status, 'interrupted');
      assert.equal(persisted.reason, 'server_restarted');
      assert.deepEqual(persisted.snapshot, next.snapshot);
      const list = await f.client.json<{ active_session_id: string | null }>(
        'GET',
        f.base + '/sessions',
      );
      assert.equal(list.active_session_id, null);
    } finally {
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.authority.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'formal machine admission rejects Users/wrong machine/session/reuse and preserves one lease; ACK needs a new boundary',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-admission'),
      peers: Source[] = [];
    try {
      const session = await f.start(),
        path = f.base + `/sessions/${session.id}/publisher-admissions`;
      await f.client.error(
        'POST',
        path,
        { machine_id: f.machine.machine.id },
        403,
        'identity.machine_unauthorized',
      );
      await f.sourceClient.error(
        'POST',
        path,
        { machine_id: f.client.session!.user.id },
        403,
        'identity.machine_unauthorized',
      );
      const wrong = await f.client.json<{
        machine: { id: string };
        credential: string;
      }>('POST', '/api/v1/machines', { name: 'Wrong source' }, 201);
      await new CoreHttp(f.target.url, {
        authorization: 'Bearer ' + wrong.credential,
      }).error(
        'POST',
        path,
        { machine_id: wrong.machine.id },
        403,
        'lab.publisher_unauthorized',
      );
      const admission = await f.admit(session);
      assert.equal(admission.bootstrap.snapshot_hash, session.snapshot.hash);
      assert.deepEqual(
        admission.bootstrap.initial_poses,
        session.snapshot.initial_poses,
      );
      await f.sourceClient.error(
        'POST',
        path,
        { machine_id: f.machine.machine.id },
        409,
        'lab.publisher_conflict',
      );
      const source = new Source(f.target, session, admission);
      peers.push(source);
      await source.ready();
      await source.frame();
      const running = await f.state(session, 'running');
      const replay = new Source(f.target, session, admission);
      peers.push(replay);
      await until(async () => replay.controls[0], Boolean);
      assert.equal(replay.controls[0].type, 'motion.error');
      assert.equal((await f.read(session)).lease_id, admission.lease_id);
      await f.client.json('POST', f.base + `/sessions/${session.id}/pause`, {
        expected_revision: running.revision,
      });
      const pause = await source.control('pause');
      await source.apply(pause, 10n);
      const paused = await f.state(session, 'paused');
      await f.client.json('POST', f.base + `/sessions/${session.id}/resume`, {
        expected_revision: paused.revision,
      });
      const resume = await source.control('resume');
      // Reuse the paused frontier deliberately; no new frame/event may make this ACK valid.
      source.ack(resume, 10n);
      await until(
        async () => source.controls.some((c) => c.type === 'motion.error'),
        Boolean,
      );
      assert.equal((await f.read(session)).status, 'resuming');
      const interrupted = await f.state(session, 'interrupted');
      assert.equal(interrupted.reason, 'source_ack_timeout');
      const next = await f.start();
      assert.notEqual(next.id, session.id);
      await f.client.json(
        'POST',
        `/api/v1/machines/${f.machine.machine.id}/revoke`,
        undefined,
        204,
      );
      const ended = await f.state(next, 'interrupted');
      assert.equal(ended.reason, 'machine_revoked');
      await f.sourceClient.error(
        'POST',
        f.base + `/sessions/${next.id}/publisher-admissions`,
        { machine_id: f.machine.machine.id },
        403,
        'identity.machine_unauthorized',
      );
    } finally {
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.admission.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'Session pause is a trusted frame boundary while heartbeat remains healthy; source progress fails closed',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-clock', 2000),
      peers: Source[] = [];
    try {
      const session = await f.start(),
        source = new Source(f.target, session, await f.admit(session));
      peers.push(source);
      await source.ready();
      await source.frame();
      const running = await f.state(session, 'running');
      const ticket = await f.client.json<Admission>(
          'POST',
          f.base + `/sessions/${session.id}/viewer-tickets`,
          { preferred_rate_hz: 30 },
          201,
        ),
        viewer = new Source(f.target, session, ticket, 'viewer');
      peers.push(viewer);
      await viewer.ready();
      await f.client.json('POST', f.base + `/sessions/${session.id}/pause`, {
        expected_revision: running.revision,
      });
      const pause = await source.control('pause');
      const boundary = await source.apply(pause, 100n, 1);
      await f.state(session, 'paused');
      await until(
        async () => viewer.controls.some((c) => c.state === 'paused'),
        Boolean,
      );
      await new Promise((resolve) => setTimeout(resolve, 2300));
      assert.equal((await f.read(session)).status, 'paused');
      assert.equal(source.ws.readyState, WebSocket.OPEN);
      assert.deepEqual(viewer.frames.at(-1), boundary);
      assert.equal(
        decodeMotionSnapshot(viewer.frames.at(-1)!).sim_time_ns,
        100n,
      );
      const paused = await f.read(session);
      await f.client.json('POST', f.base + `/sessions/${session.id}/resume`, {
        expected_revision: paused.revision,
      });
      const resume = await source.control('resume');
      await source.apply(resume, 100n, 1);
      await f.state(session, 'running');
      await until(
        async () => viewer.controls.some((c) => c.state === 'stale'),
        Boolean,
      );
      const interrupted = await f.state(session, 'interrupted');
      assert.equal(interrupted.reason, 'source_progress_timeout');
    } finally {
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.clock.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'configured source launch failure compensates without changing saved Layout and default startup requires no Python',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-unavailable');
    try {
      const before = await f.client.json('GET', f.base + '/world'),
        session = await f.client.json<Session>(
          'POST',
          f.base + '/sessions',
          { installation_id: f.installation.id },
          201,
        );
      assert.equal(session.status, 'interrupted');
      assert.equal(session.reason, 'source_unavailable');
      assert.deepEqual(await f.client.json('GET', f.base + '/world'), before);
      assert.equal(
        (
          await f.client.json<{ active_session_id: string | null }>(
            'GET',
            f.base + '/sessions',
          )
        ).active_session_id,
        null,
      );
    } finally {
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.unavailable.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'public archived/unavailable Installation and snapshot asset pins retain exact signed download bytes',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-pins'),
      peers: Source[] = [];
    try {
      const session = await f.start(),
        source = new Source(f.target, session, await f.admit(session));
      peers.push(source);
      await source.ready();
      await source.frame();
      await f.state(session, 'running');
      await f.client.error(
        'POST',
        f.base + `/installations/${f.installation.id}/archive`,
        undefined,
        409,
        'lab.installation_in_use',
      );
      for (const target of f.installation.targets)
        await f.client.json(
          'PUT',
          f.base + `/entities/${target.entity_id}/appearance`,
          { representation_id: null },
        );
      await f.client.error(
        'DELETE',
        `/api/v1/lab/assets/${f.asset.id}`,
        undefined,
        409,
        'lab.asset_in_use',
      );
      const capability = await f.client.json<{
        url: string;
        headers: Record<string, string>;
        file: { id: string; sha256: string };
      }>('GET', `/api/v1/lab/assets/${f.asset.id}/download`);
      assert.equal(
        capability.file.id,
        session.snapshot.world.assets[0].representation.file_id,
      );
      assert.equal(
        capability.file.sha256,
        session.snapshot.world.assets[0].representation.sha256,
      );
      const response = await fetch(capability.url, {
        headers: capability.headers,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
      );
      assert.equal(
        (await f.read(session)).snapshot.hash,
        session.snapshot.hash,
      );
      await f.target.stop();
      await f.target.start();
      const world = await f.client.json<Session['snapshot']['world']>(
        'GET',
        f.base + '/world',
      );
      await f.client.json('PUT', f.base + '/layout', {
        expected_version: world.lab.layout_version,
        nodes: [],
      });
      await f.client.error(
        'POST',
        f.base + '/sessions',
        {
          installation_id: f.installation.id,
          machine_id: f.machine.machine.id,
        },
        409,
        'lab.installation_unavailable',
      );
      await f.client.json(
        'POST',
        f.base + `/installations/${f.installation.id}/archive`,
        undefined,
        204,
      );
      const installations = await f.client.json<{ data: Installation[] }>(
        'GET',
        f.base + '/installations',
      );
      assert.ok(installations.data[0].archived_at);
      await f.client.error(
        'POST',
        f.base + '/sessions',
        {
          installation_id: f.installation.id,
          machine_id: f.machine.machine.id,
        },
        409,
        'lab.installation_unavailable',
      );
    } finally {
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.pins.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'persisted unsigned epoch above 2^53 survives HTTP and binary WS; expired independent machine cannot admit',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-u64'),
      peers: Source[] = [];
    try {
      const expired = await f.client.json<{
        machine: { id: string };
        credential: string;
      }>('POST', '/api/v1/machines', { name: 'Expired source' }, 201);
      await f.target.stop();
      let lease: DirectoryLease | undefined, db: Database | undefined;
      await f.target.startInProcess(
        'persisted epoch and machine expiry boundary',
        async () => {
          lease = await DirectoryLease.acquire(f.target.directory);
          db = new Database(lease);
          try {
            await db.openExisting();
            await db.readSQL(
              { id: 'session-u64-fixture', kind: 'startup' },
              'update lab.publisher_epoch set value=$1',
              ['9007199254740997'],
            );
            await db.readSQL(
              { id: 'session-expiry-fixture', kind: 'startup' },
              "update labos_threejs_core.machines set expires_at=now()-interval '1 second' where id=$1",
              [expired.machine.id],
            );
          } finally {
            await db.close();
            await lease.release();
            lease = undefined;
          }
        },
        async () => {
          try {
            await db?.close();
          } finally {
            await lease?.release();
          }
        },
      );
      await f.target.start();
      const session = await f.start(),
        before = await f.read(session);
      await new CoreHttp(f.target.url, {
        authorization: 'Bearer ' + expired.credential,
      }).error(
        'POST',
        f.base + `/sessions/${session.id}/publisher-admissions`,
        { machine_id: expired.machine.id },
        403,
        'identity.machine_unauthorized',
      );
      assert.deepEqual(await f.read(session), before);
      const admission = await f.admit(session);
      assert.equal(admission.epoch, '9007199254740998');
      const source = new Source(f.target, session, admission);
      peers.push(source);
      assert.equal((await source.ready()).epoch, '9007199254740998');
      const viewerTicket = await f.client.json<Admission>(
          'POST',
          f.base + `/sessions/${session.id}/viewer-tickets`,
          { preferred_rate_hz: 15 },
          201,
        ),
        viewer = new Source(f.target, session, viewerTicket, 'viewer');
      peers.push(viewer);
      await viewer.ready();
      await source.frame();
      await f.state(session, 'running');
      await until(
        async () => viewer.frames.length,
        (n) => n > 0,
      );
      assert.equal(
        decodeMotionSnapshot(viewer.frames[0]).epoch,
        9007199254740998n,
      );
    } finally {
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.u64.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'actual short-lived Publisher admission expiry exposes no metadata and cannot allocate a replacement lease',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-ticket-expiry'),
      peers: Source[] = [];
    try {
      const session = await f.start(),
        admission = await f.admit(session);
      await new Promise((resolve) => setTimeout(resolve, 30100));
      const source = new Source(f.target, session, admission);
      peers.push(source);
      await until(async () => source.controls[0], Boolean);
      assert.equal(source.controls[0].type, 'motion.error');
      assert.ok(source.controls.every((c) => c.type === 'motion.error'));
      assert.equal(source.frames.length, 0);
      assert.equal((await f.read(session)).lease_id, admission.lease_id);
      await f.sourceClient.error(
        'POST',
        f.base + `/sessions/${session.id}/publisher-admissions`,
        { machine_id: f.machine.machine.id },
        409,
        'lab.publisher_conflict',
      );
    } finally {
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.expiry.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'two public lifecycle SSE consumers share revisions and quiet revoked credentials close within the owner sweep',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-sse'),
      peers: Source[] = [],
      readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      const empty = await f.client.response('GET', f.base + '/sessions/events');
      assert.equal(empty.status, 200);
      await empty.body!.cancel();
      const session = await f.start(),
        source = new Source(f.target, session, await f.admit(session));
      peers.push(source);
      await source.ready();
      await source.frame();
      await f.state(session, 'running');
      const connections = await Promise.all([
        f.client.response('GET', f.base + '/sessions/events'),
        f.client.response('GET', f.base + '/sessions/events'),
      ]);
      for (const response of connections) {
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get('content-type')!,
          /text\/event-stream/,
        );
        readers.push(response.body!.getReader());
      }
      async function event(reader: ReadableStreamDefaultReader<Uint8Array>) {
        let text = '';
        while (true) {
          const next = await reader.read();
          assert.equal(next.done, false);
          text += new TextDecoder().decode(next.value);
          const blocks = text.split('\n\n');
          const data = blocks
            .slice(0, -1)
            .find((block) => block.startsWith('data: '));
          if (data)
            return JSON.parse(data.slice(6)) as {
              type: string;
              session: Session;
            };
          text = blocks.at(-1)!;
        }
      }
      const initial = await Promise.all(readers.map(event));
      assert.equal(initial[0].type, 'session');
      assert.deepEqual(initial[0], initial[1]);
      assert.equal(initial[0].session.status, 'running');
      const pausing = await f.client.json<Session>(
        'POST',
        f.base + `/sessions/${session.id}/pause`,
        { expected_revision: initial[0].session.revision },
      );
      const requested = await Promise.all(readers.map(event));
      assert.deepEqual(requested[0], requested[1]);
      assert.equal(requested[0].session.revision, pausing.revision);
      assert.equal(requested[0].session.status, 'pausing');
      const control = await source.control('pause');
      await source.apply(control, 100n);
      const paused = await Promise.all(readers.map(event));
      assert.deepEqual(paused[0], paused[1]);
      assert.equal(paused[0].session.status, 'paused');
      await f.client.json('POST', '/api/v1/auth/logout', undefined, 204);
      assert.ok(
        (await Promise.all(readers.map((reader) => reader.read()))).every(
          (next) => next.done,
        ),
      );
      assert.equal(source.ws.readyState, WebSocket.OPEN);
    } finally {
      await Promise.allSettled(readers.map((reader) => reader.cancel()));
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.sse.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);

test(
  'disconnected paused Publisher keeps deliberate pause separate from stale reception until finite interruption',
  { timeout: 60000 },
  async () => {
    const f = await fixture('session-paused-loss', 2000),
      peers: Source[] = [];
    try {
      const session = await f.start(),
        source = new Source(f.target, session, await f.admit(session));
      peers.push(source);
      await source.ready();
      await source.frame();
      const running = await f.state(session, 'running');
      const ticket = await f.client.json<Admission>(
          'POST',
          f.base + `/sessions/${session.id}/viewer-tickets`,
          { preferred_rate_hz: 30 },
          201,
        ),
        viewer = new Source(f.target, session, ticket, 'viewer');
      peers.push(viewer);
      await viewer.ready();
      await f.client.json('POST', f.base + `/sessions/${session.id}/pause`, {
        expected_revision: running.revision,
      });
      const pause = await source.control('pause'),
        boundary = await source.apply(pause, 100n, 1);
      await f.state(session, 'paused');
      await until(
        async () => viewer.controls.some((c) => c.state === 'paused'),
        Boolean,
      );
      const controls = viewer.controls.length;
      // Recording stays healthy while this test loses the live Publisher socket.
      source.disconnectMotion();
      await until(
        async () =>
          viewer.controls.slice(controls).some((c) => c.state === 'stale'),
        Boolean,
      );
      assert.equal((await f.read(session)).status, 'paused');
      assert.deepEqual(viewer.frames.at(-1), boundary);
      const interrupted = await f.state(session, 'interrupted');
      assert.equal(interrupted.reason, 'publisher_disconnected');
    } finally {
      peers.forEach((p) => p.close());
      await f.target.cleanup();
      console.log(
        JSON.stringify({
          event: 'session.paused-loss.resources',
          ledger: f.target.evidence + '/owned-resources.json',
        }),
      );
    }
  },
);
