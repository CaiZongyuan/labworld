import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readlink, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  DeviceCommand,
  DeviceTask,
  DeviceTaskResult,
  CreatedApiKey,
  LabAsset,
  MachineCredential,
  SceneInstallation,
  SimulationSession,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
import { ServerProcess } from '../support/server-process.ts';
import {
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from '../support/server-resources.ts';
import { launchMotionActor } from '../support/motion-actor.ts';
import type { ChildProcess } from 'node:child_process';
import {
  RecordingMachine,
  type RecordingAdmission,
} from './recording-machine.ts';
import {
  assertSelectedBytes,
  assertAck,
  digest,
  nextPrefix,
  readRecordingRecords,
  sourcePacket,
  frameBatch,
  recordedFrames,
  recordedSourcePackets,
  selectedFrame,
  type RecordingRecord,
} from './recording-wire-oracle.ts';
import {
  closeRecordingSockets,
  publicRecording,
  recordingEventually,
  recordingForSession,
  recordingPath,
  recordingReceipt,
  ownRecordingSocket,
  type RecordingEvent,
  type RecordingMetadata,
} from './recording-public-support.ts';

test(
  'recording retained reads enforce identities, Lab binding and delete CSRF while preserving bytes',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const machine = await start(f);
      await boundary(f, machine, 'stop', 1000000000n);
      const retained = await complete(f, machine),
        path = recordingPath(f.lab, retained.metadata.id);
      const full = await f.api.json<CreatedApiKey>(
        'POST',
        '/api/v1/api-keys',
        { name: 'Recording Agent', scopes: ['lab:full'], expires_in_days: 1 },
        201,
      );
      const narrow = await f.api.json<CreatedApiKey>(
        'POST',
        '/api/v1/api-keys',
        { name: 'Narrow Agent', scopes: ['profile:read'], expires_in_days: 1 },
        201,
      );
      const agent = new CoreHttp(f.target.url, {
        authorization: 'Bearer ' + full.secret,
      });
      const limited = new CoreHttp(f.target.url, {
        authorization: 'Bearer ' + narrow.secret,
      });
      const anonymous = new CoreHttp(f.target.url),
        wrongLab = await f.api.json<{ id: string }>(
          'POST',
          '/api/v1/lab/labs',
          { name: 'Wrong Recording Lab' },
          201,
        );
      const suffixes = [
        '',
        '/manifest',
        '/segments',
        '/events',
        '/segments/' + retained.segments[0].id,
      ];
      for (const suffix of suffixes) {
        for (const [reader, expected] of [
          [anonymous, 401],
          [limited, 403],
          [f.sourceApi, 401],
        ] as const) {
          const response = await reader.response('GET', path + suffix);
          assert.equal(response.status, expected);
          await response.arrayBuffer();
        }
        const wrong = await f.api.response(
          'GET',
          recordingPath(wrongLab.id, retained.metadata.id) + suffix,
        );
        assert.equal(wrong.status, 404);
        await wrong.arrayBuffer();
        for (const reader of [f.api, agent]) {
          const response = await reader.response('GET', path + suffix);
          assert.equal(response.status, 200);
          await response.arrayBuffer();
        }
      }
      const noCsrf = new CoreHttp(f.target.url);
      noCsrf.cookie = f.api.cookie;
      const refused = await noCsrf.response('DELETE', path);
      assert.equal(refused.status, 403);
      await refused.arrayBuffer();
      const narrowDelete = await limited.response('DELETE', path);
      assert.equal(narrowDelete.status, 403);
      await narrowDelete.arrayBuffer();
      const unchanged = await publicRecording(
        f.api,
        f.lab,
        retained.metadata.id,
      );
      assert.deepEqual(unchanged.segments, retained.segments);
      assertSelectedBytes(
        recordedSourcePackets(unchanged.records),
        machine.packets.map((packet) => packet.bytes),
      );
      await agent.json('DELETE', path, undefined, 204);
      assert.equal((await f.api.response('GET', path)).status, 404);
      recordingReceipt('recording-permission-matrix', {
        endpoints: suffixes.length,
        memberAndFullAgentReads: true,
        anonymousNarrowAndMachineDenied: true,
        wrongLabDenied: true,
        csrfFailurePreservedBytes: true,
        explicitAgentDelete: true,
      });
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording sparse trusted reports preserve independent microsecond watermarks and omit rejected facts',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      await ipc(
        f,
        { operation: 'execution', held: true },
        'execution-configured',
      );
      const device = await f.api.json<{ id: string }>(
        'POST',
        `/api/v1/lab/labs/${f.lab}/entities`,
        {
          name: 'Microsecond light',
          definition_id: 'light',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
        },
        201,
      );
      const path = `/api/v1/lab/labs/${f.lab}/entities/${device.id}`,
        run = await f.api.json<{ id: string; binding_id: string }>(
          'POST',
          path + '/program/start',
          undefined,
          201,
        );
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      const second = new Date().toISOString().slice(0, 19),
        later = second + '.123457Z',
        earlier = second + '.123456Z';
      const report = (
        sequence: number,
        values: Record<string, unknown>,
        observed_at: string,
      ) =>
        ipc(
          f,
          {
            operation: 'ordinary-report',
            report: {
              binding: run.binding_id,
              run: run.id,
              sequence,
              values,
              observed_at,
              quality: 'good',
            },
          },
          'ordinary-report-result',
        );
      assert.equal((await report(1, { on: true }, later))?.result, 'applied');
      assert.equal(
        (await report(2, { on: false }, earlier))?.result,
        'out_of_order',
      );
      assert.equal(
        (await report(2, { brightness: 37 }, earlier))?.result,
        'applied',
      );
      const world = await f.api.json<{
        entities: {
          id: string;
          observation: {
            properties: Record<
              string,
              { value: unknown; observed_at: string; sequence: number }
            >;
          };
        }[];
      }>('GET', `/api/v1/lab/labs/${f.lab}/world`);
      const observed = world.entities.find((entity) => entity.id === device.id)!
        .observation.properties;
      assert.equal(observed.on.value, true);
      assert.equal(observed.on.observed_at, later);
      assert.equal(observed.on.sequence, 1);
      assert.equal(observed.brightness.value, 37);
      assert.equal(observed.brightness.observed_at, earlier);
      assert.equal(observed.brightness.sequence, 2);
      await boundary(f, machine, 'stop', 1000000000n);
      const readback = await complete(f, machine),
        reports = readback.events.filter(
          (event) =>
            event.event_type === 'observation.report' &&
            event.entity_id === device.id,
        );
      assert.equal(reports.length, 2);
      assert.deepEqual(
        reports.map((event) => event.event.values),
        [{ on: true }, { brightness: 37 }],
      );
      assert(reports.every((event) => event.sim_time_ns === null));
      const p = (
          reports[0].event.properties as Record<string, Record<string, unknown>>
        ).on,
        q = (
          reports[1].event.properties as Record<string, Record<string, unknown>>
        ).brightness;
      assert.equal(p.observed_at, later);
      assert.equal(q.observed_at, earlier);
      assert(!('on' in (reports[1].event.properties as object)));
      recordingReceipt('recording-sparse-microseconds', {
        rejectedOlderP: true,
        independentOlderQAccepted: true,
        exactTimes: [later, earlier],
        appliedFacts: reports.length,
      });
    } finally {
      if (f.target.child?.connected)
        f.target.child.send({ operation: 'execution', held: false });
      await cleanup(f);
    }
  },
);

const sessionPath = (lab: string, id?: string) =>
  `/api/v1/lab/labs/${lab}/sessions${id ? '/' + id : ''}`;
type Context = {
  target: ServerProcess;
  api: CoreHttp;
  email: string;
  lab: string;
  asset: LabAsset;
  installation: SceneInstallation;
  credential: MachineCredential;
  sourceApi: CoreHttp;
  messages: Record<string, unknown>[];
};

async function incomplete(f: Context, session: string) {
  const recording = await recordingForSession(f.api, f.lab, session);
  await recordingEventually(
    () =>
      f.api.json<RecordingMetadata>('GET', recordingPath(f.lab, recording.id)),
    (value) => value.status === 'incomplete',
    10000,
  );
  return publicRecording(f.api, f.lab, recording.id);
}

async function fixture(ack = 3000): Promise<Context> {
  const target = await new ServerProcess().create();
  target.entry = 'tests/e2e/recording-fault-process.ts';
  target.ipc = true;
  target.env = {
    APP_ORIGIN: target.url,
    FILE_PUBLIC_ORIGIN: target.url,
    RATE_LIMIT_ENABLED: 'false',
    LAB_WORD_SYNTHETIC_SESSION: 'true',
    LAB_WORD_MOTION_ACK_MS: String(ack),
  };
  try {
    await target.start();
    const messages: Record<string, unknown>[] = [];
    target.child!.on('message', (message) =>
      messages.push(message as Record<string, unknown>),
    );
    const api = new CoreHttp(target.url),
      email = `recording-${randomUUID()}@example.test`;
    await api.register(email);
    const lab = await api.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Independent Recording reliability' },
      201,
    );
    const asset = await publishAsset(
      api,
      await readFile('tests/fixtures/lab/cube.glb'),
      'Independent Recording bytes',
    );
    const installation = await api.json<SceneInstallation>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/installations`,
      { representation_id: asset.representation.id },
      201,
    );
    const credential = await api.json<MachineCredential>(
      'POST',
      '/api/v1/machines',
      { name: 'Independent finite Recording source' },
      201,
    );
    return {
      target,
      api,
      email,
      lab: lab.id,
      asset,
      installation,
      credential,
      sourceApi: new CoreHttp(target.url, {
        authorization: 'Bearer ' + credential.credential,
      }),
      messages,
    };
  } catch (error) {
    await target.cleanup();
    throw error;
  }
}

async function ipc(f: Context, message: object, event: string) {
  f.messages.length = 0;
  f.target.child!.send(message);
  return recordingEventually(
    () => f.messages.find((value) => value.event === event),
    Boolean,
  );
}
async function state(f: Context, id: string, status: string) {
  return recordingEventually(
    () => f.api.json<SimulationSession>('GET', sessionPath(f.lab, id)),
    (value) => value.status === status,
    10000,
  );
}
async function transition(f: Context, session: string, action: string) {
  const current = await f.api.json<SimulationSession>(
    'GET',
    sessionPath(f.lab, session),
  );
  return f.api.json<SimulationSession>(
    'POST',
    sessionPath(f.lab, session) + '/' + action,
    { expected_revision: current.revision },
  );
}
async function admission(f: Context) {
  const starting = await f.api.json<SimulationSession>(
    'POST',
    sessionPath(f.lab),
    { installation_id: f.installation.id, machine_id: f.credential.machine.id },
    201,
  );
  const admitted = await f.sourceApi.json<RecordingAdmission>(
    'POST',
    sessionPath(f.lab, starting.id) + '/publisher-admissions',
    { machine_id: f.credential.machine.id },
    201,
  );
  const session = await f.api.json<SimulationSession>(
    'GET',
    sessionPath(f.lab, starting.id),
  );
  return { admitted, session };
}
async function start(f: Context) {
  const a = await admission(f),
    machine = new RecordingMachine(a.session, a.admitted, f.target.url);
  await machine.ready();
  const initial = selectedFrame(a.session, 1n, 0n);
  await machine.capture([initial]);
  machine.liveFrame(initial);
  await state(f, a.session.id, 'running');
  return machine;
}
async function boundary(
  f: Context,
  machine: RecordingMachine,
  action: 'pause' | 'resume' | 'stop',
  time: bigint,
) {
  await transition(f, machine.session.id, action);
  const control = await machine.control(action),
    last = machine.selected.at(-1)!;
  const frame = selectedFrame(
    machine.session,
    last.readBigUInt64LE(16) + 1n,
    time,
    0.25,
  );
  await machine.capture([frame]);
  await machine.applied(control);
  if (action === 'stop') await machine.end(control);
  machine.liveFrame(frame);
  machine.ack(control);
  await state(
    f,
    machine.session.id,
    action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'stopped',
  );
  return control;
}
async function complete(f: Context, machine: RecordingMachine) {
  const recording = await recordingForSession(f.api, f.lab, machine.session.id);
  await recordingEventually(
    () =>
      f.api.json<RecordingMetadata>('GET', recordingPath(f.lab, recording.id)),
    (value) => value.status === 'complete',
    10000,
  );
  return publicRecording(f.api, f.lab, recording.id);
}

async function finishResetSource(f: Context, machine: RecordingMachine) {
  const control = await machine.control('stop');
  const last = machine.selected.at(-1)!;
  const frame = selectedFrame(
    machine.session,
    last.readBigUInt64LE(16) + 1n,
    last.readBigUInt64LE(24),
    0.25,
  );
  await machine.capture([frame]);
  await machine.applied(control);
  await machine.end(control);
  machine.liveFrame(frame);
  machine.ack(control);
}
async function cleanup(f: Context) {
  try {
    await closeRecordingSockets();
  } finally {
    recordingReceipt('recording-server-ledger-' + f.target.port, {
      path: join(f.target.evidence, 'owned-resources.json'),
      owner: 'Independent Recording verifier',
    });
    await f.target.cleanup();
  }
}
function exactTime(value: unknown) {
  if (typeof value !== 'string') return value;
  const time =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/.exec(
      value,
    );
  if (!time) return value;
  const minutes =
    time[4] === 'Z'
      ? 0
      : (time[5] === '+' ? 1 : -1) *
        (Number(time[6]) * 60 + Number(time[7] ?? 0));
  // Date handles whole calendar seconds only. The original six-digit fraction
  // remains text and never passes through millisecond precision.
  const whole = Date.parse(`${time[1]}T${time[2]}Z`) - minutes * 60000;
  assert(Number.isFinite(whole), 'Invalid timestamp in public DTO comparison');
  return (
    new Date(whole).toISOString().slice(0, 19) +
    '.' +
    (time[3] ?? '').padEnd(6, '0') +
    'Z'
  );
}

function compareDto(
  fact: Record<string, unknown>,
  actual: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(actual))
    assert.deepEqual(
      exactTime(fact[key]),
      exactTime(value),
      'Prepared/committed field ' + key,
    );
}

test(
  'recording selected bytes survive sparse live delivery and exact duplicate ACK',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const machine = await start(f);
      const frames = Array.from({ length: 24 }, (_, index) =>
        selectedFrame(
          machine.session,
          BigInt(index + 2),
          BigInt(index + 1) * 33333333n,
          (index + 1) / 100,
        ),
      );
      await machine.capture(frames);
      // Only the last frame reaches live; no Viewer exists. Reliable input is
      // independently retained before send and must remain complete nevertheless.
      machine.liveFrame(frames.at(-1)!);
      await machine.duplicateLast();
      await boundary(f, machine, 'pause', 1000000000n);
      await boundary(f, machine, 'resume', 1000000000n);
      await boundary(f, machine, 'stop', 1100000000n);
      const readback = await complete(f, machine),
        packets = recordedSourcePackets(readback.records);
      assertSelectedBytes(
        packets,
        machine.packets.map((packet) => packet.bytes),
      );
      assertSelectedBytes(recordedFrames(packets), machine.selected);
      assert.equal(readback.metadata.prefix.source_ended, true);
      assert.deepEqual(
        readback.events
          .filter((event) => event.event_type === 'lifecycle.applied')
          .map((event) => event.event),
        machine.events.map((event) => event.event),
      );
      const bad = Buffer.from(machine.packets[0].bytes);
      bad[bad.length - 1] ^= 1;
      assert.notDeepEqual(
        bad,
        packets[0],
        'Byte oracle must distinguish altered content',
      );
      recordingReceipt('recording-selected-byte-proof', {
        selected: machine.selected.length,
        packets: packets.length,
        zeroViewers: true,
        duplicateDidNotAppend: true,
        prefix: readback.metadata.prefix,
      });
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording ACK-only network loss retries exact uncertain packet without duplicate append',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      proxyOwner = await new ServerProcess().create();
    const outgoing = new Set<WebSocket>();
    let proxy: WebSocketServer | undefined,
      dropped = 0;
    try {
      const a = await admission(f);
      await proxyOwner.startInProcess(
        'owned Recording ACK-loss proxy',
        async () => {
          proxy = new WebSocketServer({
            host: '127.0.0.1',
            port: proxyOwner.port,
            maxPayload: 65536,
            perMessageDeflate: false,
          });
          proxy.on('connection', (source) => {
            const target = new WebSocket(
              f.target.url.replace(/^http/, 'ws') +
                a.admitted.recording.websocket_path,
            );
            outgoing.add(target);
            let initial: { bytes: Buffer; binary: boolean } | undefined;
            source.on('error', () => source.terminate());
            target.on('error', () => {
              source.terminate();
              target.terminate();
            });
            source.on('message', (raw, binary) => {
              const bytes = Buffer.from(raw as Buffer);
              if (target.readyState === WebSocket.OPEN)
                target.send(bytes, { binary });
              else {
                assert(!initial, 'Unbounded proxy startup queue');
                initial = { bytes, binary };
              }
            });
            target.once('open', () => {
              if (initial)
                target.send(initial.bytes, { binary: initial.binary });
              initial = undefined;
            });
            target.on('message', (raw, binary) => {
              if (
                !binary &&
                JSON.parse(String(raw)).type === 'recording.ack' &&
                dropped === 0
              ) {
                dropped++;
                return;
              }
              if (source.readyState === WebSocket.OPEN)
                source.send(raw, { binary });
            });
            source.once('close', () => target.terminate());
            target.once('close', () => {
              outgoing.delete(target);
              source.terminate();
            });
          });
          await once(proxy, 'listening');
        },
        async () => {
          for (const socket of outgoing) socket.terminate();
          for (const socket of proxy?.clients ?? []) socket.terminate();
          if (proxy)
            await new Promise<void>((resolve) => proxy!.close(() => resolve()));
          assert.equal(outgoing.size, 0);
        },
      );
      const machine = new RecordingMachine(
        a.session,
        a.admitted,
        f.target.url,
        undefined,
        proxyOwner.url.replace(/^http/, 'ws'),
      );
      await machine.ready();
      const initial = selectedFrame(a.session, 1n, 0n),
        capturing = machine.capture([initial]);
      await recordingEventually(
        () => dropped,
        (value) => value === 1,
      );
      machine.retryPending();
      await capturing;
      machine.liveFrame(initial);
      await state(f, a.session.id, 'running');
      await boundary(f, machine, 'stop', 1000000000n);
      const readback = await complete(f, machine);
      assertSelectedBytes(
        recordedSourcePackets(readback.records),
        machine.packets.map((packet) => packet.bytes),
      );
      recordingReceipt('recording-network-ACK-loss', {
        suppressedActualPostSyncAck: dropped,
        originalPacketRetriedWithoutAppend: true,
        listenerLedger: join(proxyOwner.evidence, 'owned-resources.json'),
      });
    } finally {
      await cleanup(f);
      await proxyOwner.cleanup();
    }
  },
);

for (const ackMillis of [1000, 3000])
  test(
    `recording boundary rejects changed pose with identical sequence/time A=${ackMillis}`,
    { timeout: 120000 },
    async () => {
      const f = await fixture(ackMillis);
      try {
        const machine = await start(f);
        await transition(f, machine.session.id, 'pause');
        const control = await machine.control('pause'),
          correct = selectedFrame(machine.session, 2n, 1000000000n, 0.25),
          changed = selectedFrame(machine.session, 2n, 1000000000n, 0.5);
        await machine.capture([correct]);
        await machine.applied(control);
        assert.equal(correct.readBigUInt64LE(16), changed.readBigUInt64LE(16));
        assert.equal(correct.readBigUInt64LE(24), changed.readBigUInt64LE(24));
        machine.liveFrame(changed);
        machine.ack(control, changed);
        await state(f, machine.session.id, 'interrupted');
        const readback = await incomplete(f, machine.session.id);
        assert.equal(readback.metadata.integrity, 'incomplete');
        assertSelectedBytes(
          recordedFrames(recordedSourcePackets(readback.records)),
          machine.selected,
        );
        recordingReceipt('recording-altered-boundary-' + ackMillis, {
          ackMillis,
          sameSequenceAndTime: true,
          differentPose: true,
          rejected: true,
        });
      } finally {
        await cleanup(f);
      }
    },
  );

test(
  'recording write failure preserves external durable bytes and interrupts without further ACK',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const machine = await start(f),
        confirmed = [...machine.packets];
      await ipc(
        f,
        {
          operation: 'arm',
          fault: { point: 'beforeWrite', mode: 'fail', kind: 'source.packet' },
        },
        'armed',
      );
      await assert.rejects(
        machine.capture([
          selectedFrame(machine.session, 2n, 1000000000n, 0.25),
        ]),
      );
      await state(f, machine.session.id, 'interrupted');
      const readback = await incomplete(f, machine.session.id);
      assert.equal(readback.metadata.status, 'incomplete');
      assertSelectedBytes(
        recordedSourcePackets(readback.records),
        confirmed.map((packet) => packet.bytes),
      );
      assert.equal(
        machine.packets.length,
        confirmed.length,
        'Failed write received a durable receipt',
      );
      recordingReceipt('recording-write-failure', {
        recordingId: readback.metadata.id,
        integrity: readback.metadata.integrity,
        confirmedPackets: confirmed.length,
        laterAck: false,
        ledger: join(f.target.evidence, 'owned-resources.json'),
      });
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording pending command baseline preserves original input and idempotent acceptance',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      await ipc(
        f,
        { operation: 'execution', held: true },
        'execution-configured',
      );
      const light = await f.api.json<{ id: string }>(
        'POST',
        `/api/v1/lab/labs/${f.lab}/entities`,
        {
          name: 'Pending baseline light',
          definition_id: 'light',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
        },
        201,
      );
      const path = `/api/v1/lab/labs/${f.lab}/entities/${light.id}`;
      await f.api.json('POST', path + '/program/start', undefined, 201);
      const input = { capability: 'light.set_power', parameters: { on: true } },
        headers = { 'idempotency-key': randomUUID() };
      const accepted = await f.api.json<DeviceCommand>(
        'POST',
        path + '/actions',
        input,
        202,
        headers,
      );
      assert.equal(accepted.status, 'accepted');
      const machine = await start(f),
        recording = await recordingForSession(f.api, f.lab, machine.session.id),
        initial = await publicRecording(f.api, f.lab, recording.id);
      compareDto(
        initial.manifest.capture_baseline.commands.find(
          (command) => command.id === accepted.id,
        )!,
        accepted as unknown as Record<string, unknown>,
      );
      await boundary(f, machine, 'pause', 1000000000n);
      await ipc(
        f,
        { operation: 'execution', held: false },
        'execution-configured',
      );
      const succeeded = await recordingEventually(
        () =>
          f.api.json<DeviceCommand>('GET', path + '/commands/' + accepted.id),
        (command) => command.status === 'succeeded',
      );
      await f.api.json('POST', path + '/actions', input, 202, headers);
      await boundary(f, machine, 'stop', 1000000000n);
      const readback = await complete(f, machine),
        events = readback.events.filter(
          (event) =>
            (event.event.command as Record<string, unknown> | undefined)?.id ===
            accepted.id,
        );
      assert.deepEqual(
        events.map(
          (event) => (event.event.command as Record<string, unknown>).status,
        ),
        ['executing', 'succeeded'],
      );
      compareDto(
        events.at(-1)!.event.command as Record<string, unknown>,
        succeeded as unknown as Record<string, unknown>,
      );
      assert(events.every((event) => event.sim_time_ns === null));
    } finally {
      await cleanup(f);
    }
  },
);

for (const point of ['prepared', 'committed'] as const)
  test(
    `recording actual SIGKILL after ${point} recovers only witnessed command events with exact timestamps`,
    { timeout: 120000 },
    async () => {
      const f = await fixture();
      try {
        await ipc(
          f,
          { operation: 'execution', held: true },
          'execution-configured',
        );
        const light = await f.api.json<{ id: string }>(
          'POST',
          `/api/v1/lab/labs/${f.lab}/entities`,
          {
            name: 'Crash frontier light',
            definition_id: 'light',
            definition_version: '1.0',
            reality: 'simulated',
            configuration: {},
          },
          201,
        );
        const path = `/api/v1/lab/labs/${f.lab}/entities/${light.id}`;
        await f.api.json('POST', path + '/program/start', undefined, 201);
        const machine = await start(f);
        await boundary(f, machine, 'pause', 1000000000n);
        const mandatory = machine.packets.map((packet) =>
          Buffer.from(packet.bytes),
        );
        const markedRecording = await recordingForSession(
          f.api,
          f.lab,
          machine.session.id,
        );
        const markedA = await publicRecording(f.api, f.lab, markedRecording.id);
        assert(
          markedA.records.some((record) => record.kind === 'business.commit'),
        );
        await ipc(
          f,
          {
            operation: 'arm',
            fault: {
              point,
              mode: 'block',
              event_type: 'command.changed',
              status: 'accepted',
            },
          },
          'armed',
        );
        const request = f.api
          .response(
            'POST',
            path + '/actions',
            { capability: 'light.set_power', parameters: { on: true } },
            { 'idempotency-key': randomUUID() },
          )
          .catch(() => undefined);
        const reached = await recordingEventually(
          () => f.messages.find((message) => message.event === 'fault-reached'),
          Boolean,
        );
        assert(reached);
        const prepared = reached.prepared as RecordingRecord,
          expected = (prepared.data.events as RecordingEvent[]).find(
            (event) => event.event_type === 'command.changed',
          )!;
        const command = expected.event.command as Record<string, unknown>;
        assert.equal(command.status, 'accepted');
        assert.deepEqual(command.parameters, { on: true });
        let committed: DeviceCommand | undefined;
        if (point === 'committed')
          committed = await f.api.json<DeviceCommand>(
            'GET',
            path + '/commands/' + command.id,
          );
        else
          assert.equal(
            (await f.api.response('GET', path + '/commands/' + command.id))
              .status,
            404,
          );
        await f.target.stop('SIGKILL');
        await request;
        await closeRecordingSockets();
        await f.target.start();
        await f.api.login(f.email);
        await state(f, machine.session.id, 'interrupted');
        const recording = await recordingForSession(
            f.api,
            f.lab,
            machine.session.id,
          ),
          readback = await publicRecording(f.api, f.lab, recording.id);
        assertSelectedBytes(
          recordedSourcePackets(readback.records).slice(0, mandatory.length),
          mandatory,
        );
        for (const marked of markedA.events) {
          const retained = readback.events.filter(
            (event) => event.event_id === marked.event_id,
          );
          assert.equal(retained.length, 1);
          assert.deepEqual(retained[0], marked);
        }
        const events = readback.events.filter(
          (event) => event.event_id === expected.event_id,
        );
        assert.equal(events.length, point === 'committed' ? 1 : 0);
        if (committed) {
          compareDto(
            events[0].event.command as Record<string, unknown>,
            committed as unknown as Record<string, unknown>,
          );
          assert.deepEqual(events[0].event, expected.event);
          assert.equal(events[0].recorded_at, expected.recorded_at);
        }
        assert.equal(
          (
            await f.api.json<{ active_session_id: string | null }>(
              'GET',
              sessionPath(f.lab),
            )
          ).active_session_id,
          null,
        );
        await f.target.stop();
        await f.target.start();
        await f.api.login(f.email);
        const again = await publicRecording(f.api, f.lab, recording.id);
        assert.deepEqual(again.events, readback.events);
        assert.deepEqual(again.segments, readback.segments);
        assertSelectedBytes(
          recordedSourcePackets(again.records).slice(0, mandatory.length),
          mandatory,
        );
        recordingReceipt('recording-crash-' + point, {
          actualSigkill: true,
          mandatoryPackets: mandatory.length,
          visibleExpectedEvents: events.length,
          exactCommittedDtoCompared: !!committed,
          noReplay: true,
        });
      } finally {
        await cleanup(f);
      }
    },
  );

test(
  'recording shared resource deletion releases only its owner and deletion tombstone survives reopen',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const a = await start(f);
      await boundary(f, a, 'stop', 1000000000n);
      const savedA = await complete(f, a);
      const b = await start(f);
      await boundary(f, b, 'stop', 1000000000n);
      const savedB = await complete(f, b);
      for (const target of f.installation.targets)
        await f.api.json(
          'PUT',
          `/api/v1/lab/labs/${f.lab}/entities/${target.entity_id}/appearance`,
          { representation_id: null },
        );
      assert.equal(
        (await f.api.response('DELETE', `/api/v1/lab/assets/${f.asset.id}`))
          .status,
        409,
      );
      await f.api.json('POST', `/api/v1/lab/labs/${f.lab}/history/cleanup`);
      await f.api.json(
        'DELETE',
        recordingPath(f.lab, savedA.metadata.id),
        undefined,
        204,
      );
      const retained = await publicRecording(f.api, f.lab, savedB.metadata.id);
      assert.deepEqual(retained.segments, savedB.segments);
      assertSelectedBytes(
        recordedSourcePackets(retained.records),
        b.packets.map((packet) => packet.bytes),
      );
      assert.equal(
        (await f.api.response('DELETE', `/api/v1/lab/assets/${f.asset.id}`))
          .status,
        409,
      );
      await f.api.json(
        'DELETE',
        recordingPath(f.lab, savedB.metadata.id),
        undefined,
        204,
      );
      await f.api.json(
        'DELETE',
        `/api/v1/lab/assets/${f.asset.id}`,
        undefined,
        204,
      );
      await f.target.stop();
      await f.target.start();
      await f.api.login(f.email);
      assert.equal(
        (await f.api.response('GET', recordingPath(f.lab, savedA.metadata.id)))
          .status,
        404,
      );
      assert.equal(
        (await f.api.response('GET', recordingPath(f.lab, savedB.metadata.id)))
          .status,
        404,
      );
      const listed = await f.api.json<{ data: RecordingMetadata[] }>(
        'GET',
        recordingPath(f.lab),
      );
      assert.equal(listed.data.length, 0);
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording acknowledged bytes survive actual stopped-directory backup and new-directory restore',
  { timeout: 180000 },
  async () => {
    const f = await fixture(),
      restored = await new ServerProcess().create();
    try {
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      const mandatory = machine.packets.map((packet) =>
        Buffer.from(packet.bytes),
      );
      await f.target.stop('SIGKILL');
      await closeRecordingSockets();
      const archive = join(restored.directory, 'archive'),
        restoreDirectory = join(restored.directory, 'restored-data');
      async function cli(target: ServerProcess, args: string[]) {
        target.entry = 'apps/server/src/cli.ts';
        target.args = args;
        await target.spawn();
        const child = target.child!;
        if (child.exitCode === null) await once(child, 'exit');
        assert.equal(child.exitCode, 0, target.logs);
        await target.stop();
      }
      await cli(f.target, ['backup', '--output', archive]);
      restored.env = {
        APP_ORIGIN: restored.url,
        FILE_PUBLIC_ORIGIN: restored.url,
        RATE_LIMIT_ENABLED: 'false',
        LAB_WORD_DATA_DIR: restoreDirectory,
        LAB_WORD_SYNTHETIC_SESSION: 'true',
      };
      recordingReceipt('recording-archive-ownership', {
        archive,
        restoreDirectory,
        rootOwnerLedger: join(restored.evidence, 'owned-resources.json'),
        sourceLedger: join(f.target.evidence, 'owned-resources.json'),
        purpose: 'Explicit owned nested archive and new data directory',
      });
      await cli(restored, ['restore', '--archive', archive]);
      restored.entry = 'tests/e2e/recording-fault-process.ts';
      restored.args = [];
      restored.ipc = true;
      await restored.start();
      const api = new CoreHttp(restored.url);
      await api.login(f.email);
      const recording = await recordingForSession(
          api,
          f.lab,
          machine.session.id,
        ),
        readback = await publicRecording(api, f.lab, recording.id);
      assertSelectedBytes(
        recordedSourcePackets(readback.records).slice(0, mandatory.length),
        mandatory,
      );
      assert.equal(readback.metadata.integrity, 'incomplete');
      const published = readback.segments;
      await restored.stop();
      await restored.start();
      await api.login(f.email);
      const second = await publicRecording(api, f.lab, recording.id);
      assertSelectedBytes(
        recordedSourcePackets(second.records).slice(0, mandatory.length),
        mandatory,
      );
      assert.deepEqual(second.segments, published);
      assert.deepEqual(second.records, readback.records);
      assert.equal(
        (
          await api.json<{ active_session_id: string | null }>(
            'GET',
            sessionPath(f.lab),
          )
        ).active_session_id,
        null,
      );
    } finally {
      await cleanup(f);
      await restored.cleanup();
    }
  },
);

test(
  'recording completed Task survives actual kill before marker while physics stays paused at A=1000',
  { timeout: 120000 },
  async () => {
    const f = await fixture(1000);
    try {
      const device = await f.api.json<{ id: string }>(
        'POST',
        `/api/v1/lab/labs/${f.lab}/entities`,
        {
          name: 'Exact terminal Task',
          definition_id: 'centrifuge',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: { initial_temperature: 22 },
        },
        201,
      );
      const path = `/api/v1/lab/labs/${f.lab}/entities/${device.id}`;
      await f.api.json('POST', path + '/program/start', undefined, 201);
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      const pausedAt = performance.now(),
        mandatory = machine.packets.map((packet) => Buffer.from(packet.bytes));
      await ipc(
        f,
        {
          operation: 'arm',
          fault: {
            point: 'committed',
            mode: 'block',
            event_type: 'task.changed',
            status: 'completed',
          },
        },
        'armed',
      );
      const command = await f.api.json<DeviceCommand>(
        'POST',
        path + '/actions',
        {
          capability: 'centrifuge.start',
          parameters: { rpm: 500, temperature: 22, duration_seconds: 6 },
        },
        202,
        { 'idempotency-key': randomUUID() },
      );
      assert(command.task_id);
      const reached = await recordingEventually(
        () => f.messages.find((message) => message.event === 'fault-reached'),
        Boolean,
        20000,
      );
      assert(reached);
      assert(
        performance.now() - pausedAt > 1000,
        'Legal idle Pause was not observed beyond pending-fact deadline',
      );
      const task = await f.api.json<DeviceTask>(
        'GET',
        path + '/tasks/' + command.task_id,
      );
      const result = await f.api.json<DeviceTaskResult>(
        'GET',
        path + '/results/' + task.result_id,
      );
      assert.equal(task.status, 'completed');
      assert.equal(result.status, 'completed');
      assert.equal(
        (
          await f.api.json<SimulationSession>(
            'GET',
            sessionPath(f.lab, machine.session.id),
          )
        ).status,
        'paused',
      );
      const prepared = reached.prepared as RecordingRecord;
      const expected = (prepared.data.events as RecordingEvent[]).find(
        (event) =>
          event.event_type === 'task.changed' &&
          (event.event.task as Record<string, unknown>).id === task.id,
      )!;
      compareDto(
        expected.event.task as Record<string, unknown>,
        task as unknown as Record<string, unknown>,
      );
      compareDto(
        expected.event.result as Record<string, unknown>,
        result as unknown as Record<string, unknown>,
      );
      await f.target.stop('SIGKILL');
      await closeRecordingSockets();
      await f.target.start();
      await f.api.login(f.email);
      const readback = await incomplete(f, machine.session.id);
      assertSelectedBytes(
        recordedSourcePackets(readback.records).slice(0, mandatory.length),
        mandatory,
      );
      const events = readback.events.filter(
        (event) => event.event_id === expected.event_id,
      );
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].event, expected.event);
      assert.equal(events[0].recorded_at, expected.recorded_at);
      assert.deepEqual(
        await f.api.json<DeviceTask>('GET', path + '/tasks/' + task.id),
        task,
      );
      assert.deepEqual(
        await f.api.json<DeviceTaskResult>(
          'GET',
          path + '/results/' + task.result_id,
        ),
        result,
      );
      recordingReceipt('recording-completed-result-crash', {
        taskId: task.id,
        resultId: result.id,
        completedBeforeKill: true,
        recoveredExactlyOnce: true,
        idlePauseBeyondD: true,
        ackMillis: 1000,
      });
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording successor readiness write failure leaves no active unrecorded Reset Session',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      await ipc(
        f,
        {
          operation: 'arm',
          fault: { point: 'beforeWrite', mode: 'fail', kind: 'header' },
        },
        'armed',
      );
      const current = await f.api.json<SimulationSession>(
        'GET',
        sessionPath(f.lab, machine.session.id),
      );
      const reset = f.api.response(
        'POST',
        sessionPath(f.lab, current.id) + '/reset',
        { expected_revision: current.revision },
      );
      await finishResetSource(f, machine);
      const response = await reset;
      assert(response.status >= 400);
      await response.arrayBuffer();
      const list = await recordingEventually(
        () =>
          f.api.json<{
            data: SimulationSession[];
            active_session_id: string | null;
          }>('GET', sessionPath(f.lab)),
        (value) => value.active_session_id === null,
        10000,
      );
      assert(list.data.every((session) => session.ended_at));
      const recordings = await f.api.json<{ data: RecordingMetadata[] }>(
        'GET',
        recordingPath(f.lab),
      );
      assert(
        recordings.data.every(
          (recording) =>
            recording.status !== 'open' && recording.status !== 'preparing',
        ),
      );
      const old = await recordingForSession(f.api, f.lab, machine.session.id);
      assert.equal(old.snapshot_hash, machine.session.snapshot.hash);
      assertSelectedBytes(
        recordedSourcePackets(
          (await publicRecording(f.api, f.lab, old.id)).records,
        ),
        machine.packets.map((packet) => packet.bytes),
      );
      recordingReceipt('recording-reset-readiness-failure', {
        activeSession: null,
        allRetainedSessionsEnded: true,
        oldConfirmedPrefixPreserved: true,
      });
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording Reset capture handoff accounts for a concurrent ordinary Command exactly once',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      await ipc(
        f,
        { operation: 'execution', held: true },
        'execution-configured',
      );
      const device = await f.api.json<{ id: string }>(
        'POST',
        `/api/v1/lab/labs/${f.lab}/entities`,
        {
          name: 'Concurrent Reset command',
          definition_id: 'light',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
        },
        201,
      );
      const path = `/api/v1/lab/labs/${f.lab}/entities/${device.id}`;
      await f.api.json('POST', path + '/program/start', undefined, 201);
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      const current = await f.api.json<SimulationSession>(
        'GET',
        sessionPath(f.lab, machine.session.id),
      );
      const reset = f.api.json<SimulationSession>(
        'POST',
        sessionPath(f.lab, current.id) + '/reset',
        { expected_revision: current.revision },
      );
      const commandRequest = f.api.json<DeviceCommand>(
        'POST',
        path + '/actions',
        { capability: 'light.set_power', parameters: { on: true } },
        202,
        { 'idempotency-key': randomUUID() },
      );
      await finishResetSource(f, machine);
      const successor = await reset,
        command = await commandRequest;
      assert.equal(successor.snapshot.hash, machine.session.snapshot.hash);
      const admitted = await f.sourceApi.json<RecordingAdmission>(
        'POST',
        sessionPath(f.lab, successor.id) + '/publisher-admissions',
        { machine_id: f.credential.machine.id },
        201,
      );
      const scoped = await f.api.json<SimulationSession>(
        'GET',
        sessionPath(f.lab, successor.id),
      );
      const next = new RecordingMachine(scoped, admitted, f.target.url);
      await next.ready();
      const initial = selectedFrame(scoped, 1n, 0n);
      await next.capture([initial]);
      next.liveFrame(initial);
      await state(f, scoped.id, 'running');
      await boundary(f, next, 'stop', 1000000000n);
      const oldRecording = await recordingForSession(
        f.api,
        f.lab,
        machine.session.id,
      );
      const old = await publicRecording(f.api, f.lab, oldRecording.id),
        newer = await complete(f, next);
      const accepted = [...old.events, ...newer.events].filter(
        (event) =>
          event.event_type === 'command.changed' &&
          (event.event.command as Record<string, unknown>).id === command.id &&
          (event.event.command as Record<string, unknown>).status ===
            'accepted',
      );
      assert.equal(accepted.length, 1);
      compareDto(
        accepted[0].event.command as Record<string, unknown>,
        command as unknown as Record<string, unknown>,
      );
      const newerBaseline = newer.manifest.capture_baseline.commands.find(
        (value) => value.id === command.id,
      );
      if (old.events.includes(accepted[0])) {
        assert(newerBaseline);
        compareDto(
          newerBaseline,
          command as unknown as Record<string, unknown>,
        );
      }
      assertSelectedBytes(
        recordedSourcePackets(old.records),
        machine.packets.map((packet) => packet.bytes),
      );
      assert.equal(newer.metadata.snapshot_hash, old.metadata.snapshot_hash);
      recordingReceipt('recording-concurrent-handoff', {
        commandId: command.id,
        acceptedEventCount: accepted.length,
        sameOriginalSnapshot: true,
        baselinePredecessorRetainedWhenNeeded: true,
      });
      await ipc(
        f,
        { operation: 'execution', held: false },
        'execution-configured',
      );
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording managed publication survives revocation of the initiating Agent credential',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const key = await f.api.json<CreatedApiKey>(
        'POST',
        '/api/v1/api-keys',
        {
          name: 'Initiating recording Agent',
          scopes: ['lab:full'],
          expires_in_days: 1,
        },
        201,
      );
      const agent = new CoreHttp(f.target.url, {
        authorization: 'Bearer ' + key.secret,
      });
      const machine = await start({ ...f, api: agent });
      await boundary(f, machine, 'pause', 1000000000n);
      await f.api.json(
        'DELETE',
        '/api/v1/api-keys/' + key.key.id,
        undefined,
        204,
      );
      assert.equal(
        (await agent.response('GET', sessionPath(f.lab))).status,
        401,
      );
      await boundary(f, machine, 'stop', 1000000000n);
      const readback = await complete(f, machine);
      assert(
        readback.segments.length > 0 &&
          readback.segments.every(
            (segment) => segment.sealed && segment.file_id,
          ),
      );
      assertSelectedBytes(
        recordedSourcePackets(readback.records),
        machine.packets.map((packet) => packet.bytes),
      );
    } finally {
      await cleanup(f);
    }
  },
);

test('recording oracle matches literal high-epoch packet and rejects altered ACK/content', async () => {
  assert.equal(
    exactTime('2026-10-11T11:16:14.123456+08:00'),
    '2026-10-11T03:16:14.123456Z',
  );
  assert.notEqual(
    exactTime('2026-10-11T11:16:14.123457+08:00'),
    exactTime('2026-10-11T03:16:14.123456Z'),
  );
  assert.equal(
    exactTime('2026-01-01T00:00:00.123456+08:00'),
    '2025-12-31T16:00:00.123456Z',
  );
  assert.equal(
    exactTime('2026-12-31T23:30:00.123456-05:30'),
    '2027-01-01T05:00:00.123456Z',
  );
  assert.equal(
    exactTime('2026-10-11 11:16:14.984+08'),
    '2026-10-11T03:16:14.984000Z',
  );
  const vector = JSON.parse(
    await readFile(
      'packages/contracts/src/recording/golden-vectors.json',
      'utf8',
    ),
  );
  const literal = Buffer.from(vector.frame_packet_hex, 'hex');
  const packet = sourcePacket(vector.identity, 1, 1n, literal.subarray(96));
  assert.deepEqual(packet.bytes, literal);
  assert.equal(packet.digest, vector.packet_sha256);
  const prefix = nextPrefix(vector.source_prefix_seed, packet.digest);
  assert.equal(prefix, vector.ack.source_prefix_sha256);
  const expected = {
    packetSequence: 1n,
    packetHash: packet.digest,
    prefixHash: prefix,
    sourceSequence: 1n,
    eventSequence: 0n,
    ended: false,
  };
  assertAck(vector.ack, vector.identity, expected);
  assert.throws(() =>
    assertAck(
      { ...vector.ack, durable_source_sequence: '2' },
      vector.identity,
      expected,
    ),
  );
  const record = {
    ordinal: '1',
    kind: 'source.packet',
    recorded_at: '2026-10-11T00:00:00.123456Z',
    data: { packet_base64: literal.toString('base64') },
  };
  const payload = Buffer.from(JSON.stringify(record)),
    header = Buffer.alloc(36);
  header.writeUInt32LE(payload.length);
  Buffer.from(digest(payload).slice(7), 'hex').copy(header, 4);
  const bytes = Buffer.concat([header, payload]),
    decoded = readRecordingRecords(bytes);
  assert.deepEqual(decoded, [record]);
  assert.deepEqual(recordedSourcePackets(decoded), [literal]);
  const altered = Buffer.from(bytes);
  altered[altered.length - 2] ^= 1;
  assert.throws(() => readRecordingRecords(altered));
  assert.throws(() => assertSelectedBytes([literal.subarray(1)], [literal]));
});

test(
  'recording Reset post-commit marker failure compensates successor without restart or Lab blockage',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      await ipc(
        f,
        {
          operation: 'arm',
          fault: {
            point: 'committed',
            mode: 'fail',
            event_type: 'session.changed',
            status: 'reset',
          },
        },
        'armed',
      );
      const current = await f.api.json<SimulationSession>(
        'GET',
        sessionPath(f.lab, machine.session.id),
      );
      const reset = f.api.response(
        'POST',
        sessionPath(f.lab, current.id) + '/reset',
        { expected_revision: current.revision },
      );
      await finishResetSource(f, machine);
      const response = await reset;
      assert(response.status >= 400);
      await response.arrayBuffer();
      const reached = f.messages.find(
        (message) => message.event === 'fault-reached',
      );
      assert(reached);
      assert.equal(reached.point, 'committed');
      const prepared = reached.prepared as RecordingRecord;
      const oldEnd = (prepared.data.events as RecordingEvent[]).find(
        (event) =>
          event.event.session_id === current.id &&
          event.event.status === 'reset',
      );
      assert(oldEnd);
      assert(oldEnd.event.successor_session_id);
      // No restart is allowed to repair this condition. This directly observes
      // the post-business-commit/pre-marker frontier, unlike preparation failure.
      const list = await recordingEventually(
        () =>
          f.api.json<{
            data: SimulationSession[];
            active_session_id: string | null;
          }>('GET', sessionPath(f.lab)),
        (value) => value.active_session_id === null,
        5000,
      );
      const successor = list.data.find(
        (session) => session.id === oldEnd.event.successor_session_id,
      );
      assert(successor);
      assert.equal(successor.status, 'interrupted');
      assert(successor.ended_at);
      assert.equal(successor.snapshot.hash, current.snapshot.hash);
      const predecessor = await recordingForSession(f.api, f.lab, current.id);
      const oldReadback = await publicRecording(f.api, f.lab, predecessor.id);
      assertSelectedBytes(
        recordedSourcePackets(oldReadback.records),
        machine.packets.map((packet) => packet.bytes),
      );
      const newStart = await f.api.response('POST', sessionPath(f.lab), {
        installation_id: f.installation.id,
        machine_id: f.credential.machine.id,
      });
      assert.equal(
        newStart.status,
        201,
        'Failed Reset left the Lab blocked by an unowned starting successor',
      );
      const fresh = (await newStart.json()) as SimulationSession;
      await transition(f, fresh.id, 'stop');
      await state(f, fresh.id, 'interrupted');
      recordingReceipt('recording-reset-postcommit-failure', {
        faultAfterActualCommit: true,
        withoutRestart: true,
        compensatedSuccessor: successor.id,
        newOrdinaryStartAccepted: true,
      });
    } finally {
      await cleanup(f);
    }
  },
);

test(
  'recording actual Core publication failure retains ACKed candidate identity and bytes through retry and second reopen',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      await ipc(
        f,
        { operation: 'arm', fault: { point: 'beforePublish', mode: 'fail' } },
        'armed',
      );
      await boundary(f, machine, 'stop', 1000000000n);
      const first = await incomplete(f, machine.session.id),
        reached = f.messages.find(
          (message) => message.event === 'fault-reached',
        );
      assert(reached);
      assert.equal(reached.point, 'beforePublish');
      const candidate = first.segments.find(
        (segment) => segment.id === reached.detail,
      );
      assert(candidate);
      assert.equal(candidate.file_id, null);
      const mandatory = machine.packets.map((packet) =>
        Buffer.from(packet.bytes),
      );
      assertSelectedBytes(recordedSourcePackets(first.records), mandatory);
      await f.target.stop();
      await f.target.start();
      await f.api.login(f.email);
      const retried = await incomplete(f, machine.session.id),
        published = retried.segments.find(
          (segment) => segment.id === candidate.id,
        );
      assert(published && published.sealed && published.file_id);
      for (const key of [
        'id',
        'index',
        'size',
        'sha256',
        'first_ordinal',
        'last_ordinal',
      ] as const)
        assert.equal(published[key], candidate[key]);
      assertSelectedBytes(recordedSourcePackets(retried.records), mandatory);
      await f.target.stop();
      await f.target.start();
      await f.api.login(f.email);
      const second = await incomplete(f, machine.session.id);
      assert.deepEqual(second.segments, retried.segments);
      assert.deepEqual(second.records, retried.records);
      assertSelectedBytes(recordedSourcePackets(second.records), mandatory);
      recordingReceipt('recording-Core-publication-failure', {
        candidateId: candidate.id,
        index: candidate.index,
        sha256: candidate.sha256,
        mandatoryPackets: mandatory.length,
        identityAndBytesRetainedOnRetry: true,
        secondReopenExact: true,
      });
    } finally {
      await cleanup(f);
    }
  },
);

async function withinIoBudget<T>(
  promise: Promise<T>,
  millis: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), millis);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const method of ['write', 'sync'] as const)
  test(
    `recording actual native ${method} completion hold bounds ordinary caller during idle Pause and retains owned writer`,
    { timeout: 120000 },
    async () => {
      const f = await fixture(1000);
      let pending: Promise<Response> | undefined;
      try {
        await ipc(
          f,
          { operation: 'execution', held: true },
          'execution-configured',
        );
        const device = await f.api.json<{ id: string }>(
          'POST',
          `/api/v1/lab/labs/${f.lab}/entities`,
          {
            name: 'Native I/O ownership light',
            definition_id: 'light',
            definition_version: '1.0',
            reality: 'simulated',
            configuration: {},
          },
          201,
        );
        const path = `/api/v1/lab/labs/${f.lab}/entities/${device.id}`;
        await f.api.json('POST', path + '/program/start', undefined, 201);
        const a = await admission(f),
          machine = new RecordingMachine(a.session, a.admitted, f.target.url);
        const { reliable } = await machine.ready();
        const limits = reliable.limits as Record<string, number>;
        const D = limits.durability_timeout_ms;
        assert.equal(limits.lifecycle_ack_timeout_ms, 1000);
        assert.equal(D, Math.min(1000, Math.floor(1000 / 3)));
        const initial = selectedFrame(a.session, 1n, 0n);
        await machine.capture([initial]);
        machine.liveFrame(initial);
        await state(f, a.session.id, 'running');
        await boundary(f, machine, 'pause', 1000000000n);
        // Remove current appearance refs so retained asset access/refusal reflects
        // the experiment's custody rather than a current layout representation.
        for (const target of f.installation.targets)
          await f.api.json(
            'PUT',
            `/api/v1/lab/labs/${f.lab}/entities/${target.entity_id}/appearance`,
            { representation_id: null },
          );
        const recording = await recordingForSession(
            f.api,
            f.lab,
            machine.session.id,
          ),
          prior = await publicRecording(f.api, f.lab, recording.id);
        const confirmed = machine.packets.map((packet) =>
          Buffer.from(packet.bytes),
        );
        await ipc(
          f,
          { operation: 'arm-io', io: { method, recording_id: recording.id } },
          'actual-io-armed',
        );
        pending = f.api.response(
          'POST',
          path + '/actions',
          { capability: 'light.set_power', parameters: { on: true } },
          { 'idempotency-key': randomUUID() },
        );
        const held = await recordingEventually(
          () =>
            f.messages.find((message) => message.event === 'actual-io-held'),
          Boolean,
        );
        assert(held);
        assert.equal(held.actual_native_started, true);
        assert.equal(held.method, method);
        assert.equal(held.owner_pid, f.target.child!.pid);
        const planned = held.planned as RecordingRecord;
        assert(planned && planned.kind === 'business.prepare');
        const plannedCommand = (planned.data.events as RecordingEvent[]).find(
          (event) => event.event_type === 'command.changed',
        )!.event.command as Record<string, unknown>;
        assert.deepEqual(plannedCommand.parameters, { on: true });
        // D is the admitted server budget. 100ms only covers local IPC/HTTP
        // observation; it does not change a source/recorder/lifecycle timer.
        const observerMillis = D + 100,
          witnessAt = performance.now();
        const response = await withinIoBudget(
          pending,
          observerMillis,
          'Ordinary caller remained blocked beyond its admitted D while physics was idle',
        );
        assert(
          [409, 503].includes(response.status),
          'Native I/O timeout must be a controlled business refusal',
        );
        const error = (await response.json()) as { error: { code: string } };
        assert.match(error.error.code, /recording/);
        await withinIoBudget(
          recordingEventually(
            () =>
              machine.live.socket.readyState === 3 &&
              machine.reliable.socket.readyState === 3,
            Boolean,
            observerMillis,
          ),
          observerMillis,
          'Native I/O deadline did not fence both source streams',
        );
        const ledgerPath = join(
          process.env.RECORDING_E2E_OUTPUT ?? 'test-results',
          `recording-held-io-${f.target.child!.pid}.json`,
        );
        const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
          operations: {
            path: string;
            fd: number;
            product_state: string;
            closed: boolean;
            close_requested_while_held: boolean;
          }[];
        };
        const operation = ledger.operations[0];
        assert(operation);
        assert.equal(operation.product_state, 'held');
        assert.equal(operation.closed, false);
        assert.equal(operation.close_requested_while_held, false);
        if (process.platform === 'linux')
          assert.equal(
            await readlink(`/proc/${f.target.child!.pid}/fd/${operation.fd}`),
            operation.path,
          );
        assert.equal(
          (await f.api.response('DELETE', `/api/v1/lab/assets/${f.asset.id}`))
            .status,
          409,
        );
        const list = await withinIoBudget(
          f.api.response(
            'GET',
            recordingPath(f.lab, recording.id) + '/segments',
          ),
          observerMillis,
          'Segment listing followed an unsettled future tail',
        );
        assert([200, 503].includes(list.status));
        await list.arrayBuffer();
        const raw = await withinIoBudget(
          f.api.response(
            'GET',
            recordingPath(f.lab, recording.id) +
              '/segments/' +
              prior.segments.at(-1)!.id,
          ),
          observerMillis,
          'Raw segment read followed an unsettled future tail',
        );
        assert([200, 503].includes(raw.status));
        if (raw.status === 200) {
          const actual = readRecordingRecords(
              Buffer.from(await raw.arrayBuffer()),
            ),
            last = prior.segments.at(-1)!;
          assert.deepEqual(
            actual,
            prior.records.filter(
              (record) =>
                BigInt(record.ordinal) >= BigInt(last.first_ordinal) &&
                BigInt(record.ordinal) <= BigInt(last.last_ordinal),
            ),
          );
        } else await raw.arrayBuffer();
        await ipc(
          f,
          { operation: 'release-io' },
          'actual-io-release-requested',
        );
        await recordingEventually(
          () =>
            f.messages.some((message) => message.event === 'actual-io-settled'),
          Boolean,
        );
        await state(f, machine.session.id, 'interrupted');
        assert.equal(
          (await f.api.response('GET', path + '/commands/' + plannedCommand.id))
            .status,
          404,
          'Timed-out intent continued into acceptance after native completion release',
        );
        const readback = await incomplete(f, machine.session.id);
        assertSelectedBytes(recordedSourcePackets(readback.records), confirmed);
        assert(
          !readback.events.some(
            (event) =>
              (event.event.command as Record<string, unknown> | undefined)
                ?.id === plannedCommand.id,
          ),
        );
        const next = await f.api.json<DeviceCommand>(
          'POST',
          path + '/actions',
          { capability: 'light.set_power', parameters: { on: false } },
          202,
          { 'idempotency-key': randomUUID() },
        );
        await ipc(
          f,
          { operation: 'execution', held: false },
          'execution-configured',
        );
        const applied = await recordingEventually(
          () => f.api.json<DeviceCommand>('GET', path + '/commands/' + next.id),
          (command) => command.status === 'succeeded',
        );
        assert.equal(applied.status, 'succeeded');
        recordingReceipt('recording-native-io-' + method, {
          method,
          D,
          observerMillis,
          witnessToChecksMillis: performance.now() - witnessAt,
          originalNativeCallStarted: true,
          kernelMayAlreadyHaveCompleted: true,
          controlledStatus: response.status,
          stillOwnedOpenFdAtDeadline: true,
          linuxFdProbe: process.platform === 'linux',
          rawReadStatus: raw.status,
          noLateAcceptanceOrACK: true,
          subsequentOrdinaryCommand: next.id,
          ledgerPath,
        });
      } finally {
        // Resolve only our test hold before the normal owner shutdown can await or
        // close the real handle. Abnormal process recovery remains ServerProcess's.
        if (f.target.child?.connected) {
          f.target.child.send({ operation: 'release-io' });
          f.target.child.send({ operation: 'execution', held: false });
        }
        await pending?.catch(() => undefined);
        await cleanup(f);
      }
    },
  );

test(
  'recording formal cross-scope source attempt and machine revocation preserve valid-owner ACK prefix',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const machine = await start(f);
      await boundary(f, machine, 'pause', 1000000000n);
      const otherLab = await f.api.json<{ id: string }>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Other Recording scope' },
        201,
      );
      const installation = await f.api.json<SceneInstallation>(
        'POST',
        `/api/v1/lab/labs/${otherLab.id}/installations`,
        { representation_id: f.asset.representation.id },
        201,
      );
      const session = await f.api.json<SimulationSession>(
        'POST',
        sessionPath(otherLab.id),
        {
          installation_id: installation.id,
          machine_id: f.credential.machine.id,
        },
        201,
      );
      const admissionB = await f.sourceApi.json<RecordingAdmission>(
        'POST',
        sessionPath(otherLab.id, session.id) + '/publisher-admissions',
        { machine_id: f.credential.machine.id },
        201,
      );
      const b = admissionB.recording;
      const invalid = new WebSocket(
        f.target.url.replace(/^http/, 'ws') +
          `/api/v1/lab/recordings/${machine.scope.recording_id}/source`,
      );
      ownRecordingSocket(
        invalid,
        'wrong-recording-scope',
        session.id,
        b.recording_id,
      );
      let leakedReady = false;
      invalid.on('error', () => {});
      invalid.on('message', (data) => {
        if (JSON.parse(String(data)).type === 'recording.ready')
          leakedReady = true;
      });
      invalid.once('open', () =>
        invalid.send(
          JSON.stringify({
            type: 'recording.hello',
            version: 1,
            codec: 'lwr1-source-v1',
            ticket: b.ticket,
            recording_id: b.recording_id,
            session_id: b.session_id,
            lease_id: b.lease_id,
            epoch: b.epoch,
            snapshot_hash: b.snapshot_hash,
            manifest_sha256: b.manifest_sha256,
            scene_hash: b.scene_hash,
            mapping_revision: b.mapping_revision,
            mapping_sha256: b.mapping_sha256,
            source_header: {
              source_kind: 'synthetic',
              implementation: {
                name: 'cross-scope-verifier',
                version: '1',
                sha256: null,
              },
              python_version: null,
              dependencies: [],
              capture_policy: b.capture_policy,
            },
          }),
        ),
      );
      await recordingEventually(
        () => invalid.readyState,
        (state) => state === WebSocket.CLOSED,
      );
      assert.equal(leakedReady, false);
      assert.equal(
        (
          await f.api.json<SimulationSession>(
            'GET',
            sessionPath(f.lab, machine.session.id),
          )
        ).status,
        'paused',
      );
      assert.equal(machine.live.socket.readyState, WebSocket.OPEN);
      assert.equal(machine.reliable.socket.readyState, WebSocket.OPEN);
      const mandatory = machine.packets.map((packet) =>
        Buffer.from(packet.bytes),
      );
      await f.api.json(
        'POST',
        `/api/v1/machines/${f.credential.machine.id}/revoke`,
        undefined,
        204,
      );
      await state(f, machine.session.id, 'interrupted');
      await recordingEventually(
        () =>
          machine.live.socket.readyState === WebSocket.CLOSED &&
          machine.reliable.socket.readyState === WebSocket.CLOSED,
        Boolean,
      );
      const readback = await incomplete(f, machine.session.id);
      assertSelectedBytes(recordedSourcePackets(readback.records), mandatory);
      assert.equal(
        machine.reliable.messages.filter(
          (message) => message.type === 'recording.ack',
        ).length,
        0,
      );
      const again = await f.sourceApi.response(
        'POST',
        sessionPath(f.lab, machine.session.id) + '/publisher-admissions',
        { machine_id: f.credential.machine.id },
      );
      assert.equal(again.status, 403);
      await again.arrayBuffer();
      recordingReceipt('recording-source-crossscope-revocation', {
        crossRecordingAttemptDenied: true,
        validOwnerStayedPaused: true,
        bothSocketsRevoked: true,
        exactPrefixPreserved: true,
        laterAck: false,
      });
    } finally {
      await cleanup(f);
    }
  },
);

// Explicit independent performance supplement: normal Node CI remains Python
// independent. The dedicated command must enable this test and supply pinned
// Python; missing pressure is a failure, never a fulfilled/skipped assertion.
if (process.env.RECORDING_E2E_PRESSURE === 'true')
  test(
    'recording real TCP slow reader pressure preserves formal reliable selected prefix and fast Viewer',
    { timeout: 210000 },
    async () => {
      assert.equal(
        process.platform,
        'linux',
        'Actual SO_RCVBUF/PDEATHSIG pressure fixture is the Linux subset',
      );
      const python = process.env.MOTION_E2E_PYTHON;
      assert(
        python,
        'Supply the pinned isolated Python executable for this explicit pressure experiment',
      );
      const f = await fixture();
      let actor: ChildProcess | undefined,
        actorProof: ProcessIdentity | undefined;
      let stdout = '',
        stderr = '';
      const actorLedger = join(
        process.env.RECORDING_E2E_OUTPUT ?? 'test-results',
        'recording-pressure-actor.json',
      );
      const saveActor = async (state: string) => {
        await writeFile(
          actorLedger,
          JSON.stringify({
            owner_pid: process.pid,
            purpose:
              'Owned real TCP slow reader, explicit Linux pressure supplement',
            source_server_ledger: join(
              f.target.evidence,
              'owned-resources.json',
            ),
            actor: actorProof,
            state,
            kernelReceiveBufferUnmodifiedByTarget: true,
          }),
        );
      };
      try {
        const machine = await start(f);
        const ticket = await f.api.json<{
          ticket: string;
          websocket_path: string;
        }>(
          'POST',
          sessionPath(f.lab, machine.session.id) + '/viewer-tickets',
          { preferred_rate_hz: 30 },
          201,
        );
        const fastTicket = await f.api.json<{
          ticket: string;
          websocket_path: string;
        }>(
          'POST',
          sessionPath(f.lab, machine.session.id) + '/viewer-tickets',
          { preferred_rate_hz: 30 },
          201,
        );
        const fast = new WebSocket(
          f.target.url.replace(/^http/, 'ws') + fastTicket.websocket_path,
          { origin: f.target.url },
        );
        ownRecordingSocket(
          fast,
          'fast-pressure-viewer',
          machine.session.id,
          machine.scope.recording_id,
        );
        let fastFrames = 0,
          fastSequence = 0n,
          fastReady = false;
        fast.on('error', () => {});
        fast.on('message', (data, binary) => {
          if (binary) {
            const bytes = Buffer.from(data as Buffer);
            assert.equal(bytes.length, 632);
            assert.equal(bytes.readBigUInt64LE(8), BigInt(machine.scope.epoch));
            assert(bytes.readBigUInt64LE(16) > fastSequence);
            fastSequence = bytes.readBigUInt64LE(16);
            fastFrames++;
          } else if (JSON.parse(String(data)).type === 'motion.welcome')
            fastReady = true;
        });
        fast.once('open', () =>
          fast.send(
            JSON.stringify({
              type: 'motion.hello',
              version: 1,
              codec: 'pose-f32-v1',
              role: 'viewer',
              session_id: machine.session.id,
              ticket: fastTicket.ticket,
              preferred_rate_hz: 30,
            }),
          ),
        );
        await recordingEventually(() => fastReady, Boolean);
        await f.target.startInProcess(
          'owned-Python-real-TCP-reader',
          async () => {
            actor = launchMotionActor(
              python,
              'tests/support/motion-slow-reader.py',
              [
                f.target.url.replace(/^http/, 'ws') + ticket.websocket_path,
                f.target.url,
                machine.session.id,
              ],
              process.env,
            );
            actor.stdout!.on('data', (chunk) => {
              stdout += String(chunk);
              assert(stdout.length < 8192);
            });
            actor.stderr!.on('data', (chunk) => {
              stderr += String(chunk);
              assert(stderr.length < 8192);
            });
            await once(actor, 'spawn');
            actorProof = await processIdentity(actor.pid!);
            assert(actorProof);
            await saveActor('owned');
            actor.stdin!.end(ticket.ticket + '\n');
          },
          async () => {
            if (
              actor?.pid &&
              actor.exitCode === null &&
              actor.signalCode === null
            ) {
              const current = await processIdentity(actor.pid);
              assert(
                !current || (actorProof && sameProcess(current, actorProof)),
              );
              const exit = once(actor, 'exit');
              actor.kill('SIGTERM');
              const timer = setTimeout(() => actor!.kill('SIGKILL'), 1000);
              try {
                await exit;
              } finally {
                clearTimeout(timer);
              }
            }
            if (actorProof)
              assert.equal(await processIdentity(actorProof.pid), undefined);
            await saveActor('cleaned');
          },
        );
        const admitted = await recordingEventually(
          () =>
            stdout
              .split('\n')
              .flatMap((line) => {
                try {
                  return [
                    JSON.parse(line) as {
                      event: string;
                      local_port: number;
                      receive_buffer_bytes: number;
                    },
                  ];
                } catch {
                  return [];
                }
              })
              .find((line) => line.event === 'slow.admitted'),
          Boolean,
          10000,
        );
        assert(admitted);
        assert(admitted.receive_buffer_bytes >= 4096);
        await ipc(
          f,
          { operation: 'pressure-observe' },
          'pressure-observer-ready',
        );
        const spool = join(
          f.target.directory,
          'pressure-selected-packets.jsonl',
        );
        for (const packet of machine.packets)
          await appendFile(spool, packet.bytes.toString('base64') + '\n');
        const started = performance.now();
        let deadline = started,
          sequence = 1n,
          pressure: Record<string, unknown> | undefined,
          peak = 0;
        while (performance.now() - started < 180000) {
          sequence++;
          const frame = selectedFrame(
            machine.session,
            sequence,
            (sequence - 1n) * 33333333n,
            Number(sequence - 1n) / 5000,
          );
          const expected = sourcePacket(
            machine.scope,
            1,
            BigInt(machine.packets.at(-1)!.receipt.source_packet_sequence) + 1n,
            frameBatch([frame]),
          );
          await appendFile(spool, expected.bytes.toString('base64') + '\n'); // Independent input witness BEFORE source submission.
          await machine.capture([frame]);
          assert.deepEqual(machine.packets.at(-1)!.bytes, expected.bytes);
          machine.liveFrame(frame);
          // Only the external disk oracle grows; client outstanding/history memory stays bounded.
          machine.selected.splice(0, machine.selected.length - 1);
          machine.packets.splice(0, machine.packets.length - 1);
          if (Number(sequence) % 30 === 0) {
            const snapshot = await ipc(
              f,
              { operation: 'pressure-snapshot' },
              'pressure-observer',
            );
            assert(snapshot);
            const slow = (
              snapshot.viewers as {
                remote_port: number;
                max_buffer_bytes: number;
                close_reason: string | null;
                open: boolean;
              }[]
            ).find((row) => row.remote_port === admitted.local_port);
            assert(slow);
            peak = Math.max(peak, slow.max_buffer_bytes);
            await f.api.json('GET', `/api/v1/lab/labs/${f.lab}/world`);
            if (
              slow.max_buffer_bytes > 65536 &&
              slow.close_reason === 'slow_viewer' &&
              !slow.open
            ) {
              pressure = snapshot;
              break;
            }
          }
          deadline += 1000 / 30;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline - performance.now())),
          );
        }
        recordingReceipt('recording-real-pressure-measurement', {
          realSocket: admitted,
          peakServerBufferedBytes: peak,
          elapsedMillis: performance.now() - started,
          actualPressureObserved: !!pressure,
          observer: pressure,
          actorStdout: stdout,
          actorStderrClassOnly: stderr ? 'present' : null,
          sourceRows: sequence.toString(),
        });
        assert(
          pressure,
          'Real TCP probe did not reach measured soft pressure/disconnection within180s; this is not pressure acceptance',
        );
        assert.equal(fast.readyState, WebSocket.OPEN);
        assert(fastFrames > 30);
        const retainedPacketCount = machine.packets.length;
        await boundary(f, machine, 'stop', (sequence + 1n) * 33333333n);
        for (const packet of machine.packets.slice(retainedPacketCount))
          await appendFile(spool, packet.bytes.toString('base64') + '\n');
        const expected = (await readFile(spool, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => Buffer.from(line, 'base64'));
        const readback = await complete(f, machine);
        assertSelectedBytes(recordedSourcePackets(readback.records), expected);
        await ipc(f, { operation: 'pressure-stop' }, 'pressure-observer');
        recordingReceipt('recording-real-pressure-proof', {
          actualServerSoftExceeded: true,
          slowReaderDisconnectedByExistingPolicy: true,
          fastViewerFrames: fastFrames,
          ordinaryHttpWorked: true,
          selectedPacketCount: expected.length,
          allExactBytesRetained: true,
          externalSpoolOwnedAndRemovedByServerLedger: spool,
          unchangedLimits: { soft: 65536, hard: 262144, slowMillis: 2000 },
        });
      } finally {
        await cleanup(f);
      }
    },
  );
