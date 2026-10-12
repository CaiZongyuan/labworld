import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { Database, sql } from '../../packages/server/src/platform/db/index.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { MachineService } from '../../packages/server/src/core/machines/use-cases.ts';
import { machineRoutes } from '../../packages/server/src/core/machines/routes.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { worldRoutes } from '../../packages/server/src/lab/world/routes.ts';
import { SimulationSessions } from '../../packages/server/src/lab/sessions/service.ts';
import type { Installation } from '../../packages/server/src/lab/sessions/dto.ts';
import {
  RecordingService,
  defaultRecordingOptions,
} from '../../packages/server/src/lab/recordings/service.ts';
import type { MotionTransport } from '../../packages/server/src/lab/motion/gateway.ts';
import { ServerProcess } from '../support/server-process.ts';

// Source callbacks are a necessary public capability: HTTP cannot force their
// ordering relative to the authority tick. Identity and persisted results use
// the real HTTP modules, database, Recording owner and file storage.
async function fixture(withRecording: boolean) {
  const target = await new ServerProcess().create();
  const db = new Database();
  let now = '2026-10-11T00:00:00.000Z';
  const config = configuration({
    APP_ORIGIN: target.url,
    FILE_PUBLIC_ORIGIN: target.url,
    LAB_WORD_DATA_DIR: target.directory,
  });
  const context = { db, clock: { now: () => now } };
  const world = new WorldService(context, config.auth);
  const sessions = new SimulationSessions(world, {
    enabled: true,
    managedSynthetic: false,
    graceMillis: 60000,
    ackMillis: 1000,
  });
  const files = new FileService(
    context,
    config.files,
    config.auth,
    target.url,
    target.directory,
  );
  const recording = withRecording
    ? new RecordingService(
        world,
        files,
        target.directory,
        defaultRecordingOptions,
      )
    : undefined;
  try {
    await target.startInProcess(
      'controlled-session-faults',
      async () => {
        await db.initialize();
        if (recording) {
          await files.initialize();
          await recording.initialize();
          sessions.configureRecording(recording);
        }
      },
      async () => {
        await sessions.stop();
        await recording?.stop();
        await db.close();
      },
    );
    const app = coreApp(context, 'test', config.auth, () => {}, {
      ...config.rate,
      enabled: false,
    });
    worldRoutes(app, world);
    machineRoutes(app, new MachineService(context, config.auth, 'lab:full'));
    const response = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { origin: target.url, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'faults@example.test',
        password: 'a-long-test-password',
      }),
    });
    assert.equal(response.status, 201);
    const actor = await response.json();
    const headers = new Headers({
      origin: target.url,
      cookie: response.headers.get('set-cookie')!.split(';')[0],
      'x-csrf-token': actor.csrf_token,
      'content-type': 'application/json',
    });
    async function post(path: string, body: unknown) {
      const response = await app.request(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 201);
      return response.json();
    }
    const lab = await post('/api/v1/lab/labs', {
      name: 'Fault callback ordering',
    });
    const machine = await post('/api/v1/machines', {
      name: 'Independent source',
    });
    // A minimal persisted installation keeps geometry outside this lifecycle
    // regression. No private live-owner state or callbacks are exposed.
    const installation: Installation = {
      id: randomUUID(),
      lab_id: lab.id,
      package_id: 'development-synthetic',
      package_version: '1',
      scene_hash: 'sha256:' + 'a'.repeat(64),
      mapping_revision: 1,
      pose_keys: [],
      joint_keys: [],
      targets: [],
      created_at: now,
      archived_at: null,
    };
    await db.transaction({ id: randomUUID(), kind: 'startup' }, (tx) =>
      tx.execute(
        sql`insert into lab.scene_installations(id,lab_id,metadata,created_by,created_at) values(${installation.id}::uuid,${lab.id}::uuid,${JSON.stringify(installation)}::jsonb,${actor.user.id}::uuid,${now}::timestamptz)`,
      ),
    );
    const session = await sessions.start(headers, randomUUID(), lab.id, {
      installation_id: installation.id,
      machine_id: machine.machine.id,
    });
    const admission = await sessions.admit(
      new Headers({ authorization: 'Bearer ' + machine.credential }),
      randomUUID(),
      lab.id,
      session.id,
      machine.machine.id,
    );
    let secondaryCallbacks = 0,
      open = true;
    const transport: MotionTransport = {
      get open() {
        return open;
      },
      bufferedAmount: 0,
      send() {},
      close() {
        open = false;
        secondaryCallbacks++;
        binding.leave();
        sessions.sourceExited(session.id);
      },
    };
    const binding = sessions.bind(session.id, admission.lease_id, transport);
    return {
      target,
      sessions,
      recording,
      session,
      admission,
      headers,
      lab,
      machine,
      binding,
      transport,
      callbacks: () => secondaryCallbacks,
      setTime(value: string) {
        now = value;
      },
      read: () => sessions.get(headers, randomUUID(), lab.id, session.id),
    };
  } catch (error) {
    await target.cleanup();
    throw error;
  }
}

for (const withRecording of [false, true])
  test(`machine revocation replaces a transient disconnect and survives close/exit callbacks${withRecording ? ' with Recording' : ''}`, async () => {
    const f = await fixture(withRecording);
    try {
      f.binding.leave();
      const ending = f.sessions.machineRevoked(f.machine.machine.id);
      f.sessions.sourceExited(f.session.id);
      f.binding.leave();
      await ending;
      const ended = await f.read();
      assert.equal(ended.status, 'interrupted');
      assert.equal(ended.reason, 'machine_revoked');
      if (f.recording) {
        const records = await f.recording.list(f.headers, f.lab.id);
        assert.equal(records.data[0].reason, ended.reason);
        assert.equal(records.data[0].status, 'incomplete');
      }
    } finally {
      await f.target.cleanup();
    }
  });

test('persisted machine expiry retains the same first fault in Session and Recording through synchronous socket close/child exit', async () => {
  const f = await fixture(true);
  try {
    f.setTime('2026-11-12T00:00:00.000Z');
    await f.sessions.tick();
    f.setTime('2026-10-11T00:00:00.000Z');
    const ended = await f.read();
    assert.equal(ended.status, 'interrupted');
    assert.equal(ended.reason, 'machine_expired');
    assert(f.callbacks() > 0);
    const records = await f.recording!.list(f.headers, f.lab.id);
    assert.equal(records.data[0].reason, ended.reason);
    assert.equal(records.data[0].status, 'incomplete');
  } finally {
    await f.target.cleanup();
  }
});

test('a first Recording fault survives later machine invalidation and secondary close/exit', async () => {
  const f = await fixture(true);
  try {
    f.recording!.faultSession(f.session.id, 'recording_write_failed');
    await f.sessions.machineRevoked(f.machine.machine.id);
    const ended = await f.read();
    assert.equal(ended.status, 'interrupted');
    assert.equal(ended.reason, 'recording_write_failed');
    assert(f.callbacks() > 0);
    const records = await f.recording!.list(f.headers, f.lab.id);
    assert.equal(records.data[0].reason, ended.reason);
  } finally {
    await f.target.cleanup();
  }
});

test('an ordinary disconnect can rebind within grace and produce a running Session', async () => {
  const f = await fixture(false);
  try {
    f.binding.leave();
    assert.equal((await f.read()).ended_at, null);
    const successor = f.sessions.bind(f.session.id, f.admission.lease_id, {
      open: true,
      bufferedAmount: 0,
      send() {},
      close() {},
    });
    successor.frame({
      epoch: BigInt(f.admission.epoch),
      sequence: 1n,
      sim_time_ns: 0n,
      mapping_revision: 1,
      poses: [],
      joints: [],
    });
    successor.pong();
    await f.sessions.tick();
    const current = await f.read();
    assert.equal(current.status, 'running');
    assert.equal(current.reason, null);
    assert.equal(current.ended_at, null);
  } finally {
    await f.target.cleanup();
  }
});
