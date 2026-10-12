import { HistoryService } from '../../packages/server/src/lab/history/use-cases.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deviceHttpFixture } from '../support/device-http.ts';
import { CoreHttp } from '../support/core-http.ts';
import { sql } from '../../packages/server/src/platform/db/index.ts';
import { provisionMachineIn } from '../../packages/server/src/core/machines/use-cases.ts';
import { RobotControls } from '../../packages/server/src/lab/devices/robot.ts';
import {
  DeviceRecordingCapture,
  type CaptureHost,
} from '../../packages/server/src/lab/recordings/capture-plan.ts';
import { catalog } from '../../packages/server/src/lab/world/catalog.ts';
import type { Session } from '../../packages/server/src/lab/sessions/dto.ts';
import {
  parseRobotSourceEvent,
  encodeRecordingPacket,
  decodeRecordingPacket,
  type RobotSourceEvent,
  type RecordingIdentity,
} from '../../packages/contracts/src/recording/index.ts';

test('robot HTTP requests reserve one task, enforce auth/idempotency and use only source results', async () => {
  const f = await deviceHttpFixture();
  try {
    const entity = await f.client.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs/' + f.lab.id + '/entities',
      {
        name: 'Controlled SO-101',
        definition_id: 'robot',
        definition_version: '1.1',
        reality: 'simulated',
        configuration: {},
      },
      201,
    );
    const installation = randomUUID(),
      sessionId = randomUUID(),
      recording = randomUUID(),
      lease = randomUUID();
    const session = {
      id: sessionId,
      lab_id: f.lab.id,
      installation_id: installation,
      status: 'running',
      epoch: '1',
      lease_id: lease,
      ended_at: null,
      snapshot: {
        physics: { control_mode: 'controlled' },
        installation: {
          targets: [{ object_key: 'so101', entity_id: entity.id }],
        },
      },
    } as Session;
    await f.db.transaction(
      { id: 'robot:fixture', kind: 'background' },
      async (tx) => {
        const users = await tx.execute<{ id: string }>(
            sql`select id::text from labos_threejs_core.users where email='member@example.test'`,
          ),
          actor = users.rows[0].id;
        const machine = await provisionMachineIn(
          tx,
          actor,
          'isolated robot source',
          f.context.clock.now(),
        );
        await tx.execute(
          sql`insert into lab.scene_installations(id,lab_id,metadata,created_by) values(${installation}::uuid,${f.lab.id}::uuid,'{}'::jsonb,${actor}::uuid)`,
        );
        await tx.execute(
          sql`insert into lab.simulation_sessions(id,lab_id,installation_id,machine_id,snapshot,status,epoch,lease_id,started_by) values(${sessionId}::uuid,${f.lab.id}::uuid,${installation}::uuid,${machine.machine.id}::uuid,${JSON.stringify(session.snapshot)}::jsonb,'running',1,${lease}::uuid,${actor}::uuid)`,
        );
        await tx.execute(
          sql`insert into lab.recordings(id,session_id,lab_id,created_by,snapshot_hash,capture_entity_ids,status,started_at) values(${recording}::uuid,${sessionId}::uuid,${f.lab.id}::uuid,${actor}::uuid,'fixture','[]'::jsonb,'open',now())`,
        );
      },
    );
    const captured: string[] = [];
    const host: CaptureHost = {
      hasActiveRecordings: () => true,
      covers: () => true,
      gate: async (_labs, work) => work(),
      scope: async () => ({ lab: f.lab.id, entities: [entity.id] }),
      prepare: async (events) => {
        captured.push(...events.map((e) => e.event_type));
        return [];
      },
      witness: async () => {},
      commit: async () => {},
      abort: async () => {},
      failed: () => {},
    };
    const controls = new RobotControls(
      f.context,
      new DeviceRecordingCapture(f.db, host),
    );
    // Stop before source admission calls cleanup while the real HTTP database
    // operation is still active, even though no robot Run was created.
    await f.db.operation(
      { id: 'robot:unadmitted-stop-request', kind: 'request' },
      () =>
        controls.end(
          { ...session, status: 'stopped', ended_at: f.context.clock.now() },
          false,
        ),
    );
    const identity = await controls.bind(session, recording);
    assert.deepEqual(await controls.bind(session, recording), identity);
    assert(captured.includes('program.changed'));
    assert.equal(
      (await f.entity(entity.id)).binding?.program_id,
      'newton.so101.v1',
    );
    assert.equal(
      (await f.entity(entity.id)).capabilities.find(
        (c) => c.id === 'robot.home',
      )?.binding_implemented,
      true,
    );
    const request = { capability: 'robot.home', parameters: {} };
    const unauth = new CoreHttp(f.target.url, { connection: 'close' });
    await unauth.error(
      'POST',
      f.path(entity.id) + '/actions',
      request,
      401,
      'auth.unauthorized',
      { 'idempotency-key': 'unauth' },
    );
    const token = f.client.csrf;
    f.client.csrf = undefined;
    const forbidden = await f.client.response(
      'POST',
      f.path(entity.id) + '/actions',
      request,
      { 'idempotency-key': 'csrf' },
    );
    assert.equal(forbidden.status, 403);
    await forbidden.arrayBuffer();
    f.client.csrf = token;
    await f.client.error(
      'POST',
      f.path(entity.id) + '/actions',
      {
        capability: 'robot.move_joints',
        parameters: { joints: [100, 0, 0, 0, 0, 0] },
      },
      422,
      'lab.invalid_parameters',
      { 'idempotency-key': 'invalid' },
    );
    const command = await f.action(entity.id, 'robot.home', {}, 'home');
    assert.equal(command.status, 'accepted');
    assert(command.task_id);
    assert.equal(
      (await f.action(entity.id, 'robot.home', {}, 'home')).id,
      command.id,
    );
    await f.client.error(
      'POST',
      f.path(entity.id) + '/actions',
      { capability: 'robot.set_gripper', parameters: { position: 0.7 } },
      409,
      'idempotency.conflict',
      { 'idempotency-key': 'home' },
    );
    await f.client.error(
      'POST',
      f.path(entity.id) + '/actions',
      { capability: 'robot.home', parameters: {} },
      409,
      'lab.device_busy',
      { 'idempotency-key': 'busy' },
    );
    await f.runtime.tick();
    assert.equal(
      (await f.command(entity.id, command.id)).status,
      'accepted',
      'Built-in runtime must never claim the remote command',
    );
    const scope = {
      recording_id: recording,
      session_id: sessionId,
      lease_id: lease,
      epoch: '1',
    } as RecordingIdentity;
    assert.equal((await controls.commands(scope))[0].command_id, command.id);
    let eventSequence = 0;
    const event = (
      status:
        'running' | 'cancel_requested' | 'completed' | 'cancelled' | 'failed',
      id = command.id,
      task = command.task_id,
    ): RobotSourceEvent => ({
      source_event_sequence: String(++eventSequence),
      event_id: randomUUID(),
      event_type: 'robot.task',
      subject: { session_id: sessionId, ...identity },
      sim_time_ns: '1000000000',
      observed_at: f.context.clock.now(),
      event: {
        command_id: id,
        task_id: task ?? null,
        status,
        phase: status,
        reason: null,
        joints: [0, 0, 0, 0, 0, 0.7],
        velocity: [0, 0, 0, 0, 0, 0],
      },
    });
    const running = event('running');
    await controls.apply(sessionId, recording, running);
    assert.equal((await f.task(entity.id, command.task_id!)).status, 'running');
    assert.equal((await f.command(entity.id, command.id)).status, 'executing');
    const cancel = await f.action(entity.id, 'robot.cancel', {}, 'cancel');
    assert.equal(cancel.task_id, command.task_id);
    await controls.apply(sessionId, recording, event('cancel_requested'));
    assert.equal(
      (await f.task(entity.id, command.task_id!)).status,
      'decelerating',
    );
    const cancelled = event('cancelled');
    await controls.apply(sessionId, recording, cancelled);
    await controls.apply(sessionId, recording, cancelled);
    await controls.apply(
      sessionId,
      recording,
      event('completed', cancel.id, cancel.task_id),
    );
    assert.equal(
      (await f.task(entity.id, command.task_id!)).status,
      'cancelled',
      'Cancel receipt must not overwrite the original physical task',
    );
    assert.equal((await f.command(entity.id, cancel.id)).status, 'succeeded');
    await f.db.transaction(
      { id: 'robot:fixture:pause', kind: 'background' },
      (tx) =>
        tx.execute(
          sql`update lab.simulation_sessions set status='paused' where id=${sessionId}::uuid`,
        ),
    );
    await f.client.error(
      'POST',
      f.path(entity.id) + '/actions',
      { capability: 'robot.home', parameters: {} },
      409,
      'lab.session_not_running',
      { 'idempotency-key': 'paused-home' },
    );
    await f.db.transaction(
      { id: 'robot:fixture:resume', kind: 'background' },
      (tx) =>
        tx.execute(
          sql`update lab.simulation_sessions set status='running' where id=${sessionId}::uuid`,
        ),
    );
    const key = await f.client.json<{ secret: string }>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Robot Agent', scopes: ['lab:full'], expires_in_days: 1 },
      201,
    );
    const agent = new CoreHttp(f.target.url, {
      connection: 'close',
      authorization: 'Bearer ' + key.secret,
    });
    const home2 = await agent.json<Awaited<ReturnType<typeof f.action>>>(
      'POST',
      f.path(entity.id) + '/actions',
      { capability: 'robot.home', parameters: {} },
      202,
      { 'idempotency-key': 'home2' },
    );
    assert.equal(home2.actor_source, 'agent');
    const confirmed = event('completed', home2.id, home2.task_id);
    // A source packet can be synced before projection. Recover its confirmed
    // physical result after an interrupted projection; never dispatch it again.
    await f.db.operation(
      { id: 'robot:active-stop-request', kind: 'request' },
      () =>
        controls.end(
          {
            ...session,
            status: 'interrupted',
            ended_at: f.context.clock.now(),
            reason: 'source_disconnected',
          },
          true,
        ),
    );
    assert.equal(
      (await f.task(entity.id, home2.task_id!)).status,
      'interrupted',
    );
    await controls.apply(sessionId, recording, confirmed);
    assert.equal((await f.task(entity.id, home2.task_id!)).status, 'completed');
    assert.equal((await f.command(entity.id, home2.id)).status, 'succeeded');
    await f.runtime.initialize();
    assert.equal((await f.task(entity.id, home2.task_id!)).status, 'completed');
    assert.equal((await f.command(entity.id, home2.id)).status, 'succeeded');
    await f.db.transaction(
      { id: 'robot:fixture:end', kind: 'background' },
      (tx) =>
        tx.execute(
          sql`update lab.simulation_sessions set status='interrupted',ended_at=now() where id=${sessionId}::uuid`,
        ),
    );
    assert.equal((await controls.commands(scope)).length, 0);
    const history = new HistoryService(f.context, f.policy);
    const cleaned = await f.db.transaction(
      { id: 'robot:history:cleanup', kind: 'background' },
      (tx) => history.cleanupIn(tx, f.lab.id, '2027-01-01T00:00:00.000Z'),
    );
    assert(cleaned.commands >= 3 && cleaned.tasks >= 2);
    await controls.apply(sessionId, recording, confirmed);
    await agent.error(
      'POST',
      f.path(entity.id) + '/actions',
      { capability: 'robot.home', parameters: {} },
      410,
      'lab.command_expired',
      { 'idempotency-key': 'home2' },
    );
    assert.deepEqual(
      catalog
        .find((d) => d.id === 'robot' && d.version === '1.0')!
        .capabilities.map((c) => c.implemented),
      [false, false, false],
    );
  } finally {
    await f.close();
    console.log(
      JSON.stringify({
        event: 'robot.fixture.reconciled',
        ledger: f.target.evidence + '/owned-resources.json',
      }),
    );
  }
});

test('robot reliable packet is typed separately from lifecycle and rejects malformed measurements', async () => {
  const event: RobotSourceEvent = {
    source_event_sequence: '1',
    event_id: randomUUID(),
    event_type: 'robot.observation',
    subject: {
      session_id: randomUUID(),
      entity_id: randomUUID(),
      binding_id: randomUUID(),
      run_id: randomUUID(),
    },
    sim_time_ns: '12',
    observed_at: null,
    event: {
      joints: [0.1, 0, 0, 0, 0, 0.7],
      velocity: [0, 0, 0, 0, 0, 0],
      phase: 'hold',
    },
  };
  const payload = new TextEncoder().encode(JSON.stringify(event));
  const raw = await encodeRecordingPacket({
    kind: 4,
    recording_id: randomUUID(),
    session_id: event.subject.session_id,
    epoch: 1n,
    source_packet_sequence: 1n,
    payload,
  });
  const decoded = await decodeRecordingPacket(raw);
  assert.equal(decoded.kind, 4);
  assert.deepEqual(
    parseRobotSourceEvent(new TextDecoder().decode(decoded.payload)),
    event,
  );
  assert.throws(() =>
    parseRobotSourceEvent(
      JSON.stringify({ ...event, event: { ...event.event, joints: [0] } }),
    ),
  );
  assert.throws(() =>
    parseRobotSourceEvent(
      JSON.stringify({
        ...event,
        subject: { ...event.subject, unexpected: true },
      }),
    ),
  );
});
