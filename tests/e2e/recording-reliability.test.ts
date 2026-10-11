import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
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
  type RecordingEvent,
  type RecordingMetadata,
} from './recording-public-support.ts';

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
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00(?::00)?)$/.exec(
      value,
    );
  return time
    ? `${time[1]}T${time[2]}.${(time[3] ?? '').padEnd(6, '0')}Z`
    : value;
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
