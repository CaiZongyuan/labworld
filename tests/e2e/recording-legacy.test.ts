import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  DeviceCommand,
  DownloadCapability,
  LabAsset,
  MachineCredential,
  SceneInstallation,
  SimulationSession,
} from '../../packages/contracts/src/generated/types.gen.ts';
import {
  Database,
  type DbMeasurement,
} from '../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
import { ServerProcess } from '../support/server-process.ts';
import {
  closeRecordingSockets,
  publicRecording,
  recordingEventually,
  recordingForSession,
  recordingPath,
  recordingReceipt,
  type RecordingEvent,
} from './recording-public-support.ts';
import { digest, selectedFrame } from './recording-wire-oracle.ts';
import {
  RecordingMachine,
  type RecordingAdmission,
} from './recording-machine.ts';

const sessionPath = (lab: string, session?: string) =>
  `/api/v1/lab/labs/${lab}/sessions${session ? '/' + session : ''}`;
type LegacyFixture = {
  target: ServerProcess;
  api: CoreHttp;
  email: string;
  lab: string;
  asset: LabAsset;
  installation: SceneInstallation;
  machine: MachineCredential;
  session: SimulationSession;
  bytes: Buffer;
};
type Application = Omit<LegacyFixture, 'session'>;

async function cleanup(target: ServerProcess) {
  try {
    await target.cleanup();
  } finally {
    recordingReceipt('recording-legacy-server-ledger-' + target.port, {
      path: target.evidence + '/owned-resources.json',
      owner: 'Independent Recording legacy and SQL verifier',
    });
  }
}
type Custody = {
  schemaVersion: number;
  history: { hash: string; created_at: string }[];
  sessions: {
    id: string;
    status: string;
    ended_at: string | null;
    snapshot: SimulationSession['snapshot'];
  }[];
  sessionAssets: {
    session_id: string;
    representation_id: string;
    file_id: string;
  }[];
  references: { file_id: string; owner_type: string; owner_id: string }[];
  recordings: { id: string; session_id: string; status: string }[];
  resources: { recording_id: string; file_id: string; role: string }[];
};

// Supporting custody evidence is read only while the Server is stopped. The
// existing supervisor records this in-process lease/DB consumer before it opens,
// including interruption cleanup; the assertions themselves use public bytes.
async function custody(target: ServerProcess): Promise<Custody> {
  assert.equal(target.child, undefined);
  let lease: DirectoryLease | undefined;
  let db: Database | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await db?.close();
    } finally {
      await lease?.release();
    }
  };
  try {
    await target.startInProcess(
      'Recording legacy read-only custody ' + randomUUID(),
      async () => {
        lease = await DirectoryLease.acquire(target.directory);
        db = new Database(lease);
        await db.openExisting();
      },
      close,
    );
    const facts = await db!.archiveFacts();
    const operation = {
      id: 'legacy:custody:' + randomUUID(),
      kind: 'startup' as const,
    };
    const present = await db!.readSQL<{ recordings: string | null }>(
      operation,
      "select to_regclass('lab.recordings')::text as recordings",
    );
    return {
      schemaVersion: facts.schemaVersion,
      history: facts.history,
      sessions: await db!.readSQL(
        operation,
        'select id::text,status,ended_at,snapshot from lab.simulation_sessions order by id',
      ),
      sessionAssets: await db!.readSQL(
        operation,
        'select session_id::text,representation_id::text,file_id::text from lab.session_assets order by session_id,representation_id',
      ),
      references: await db!.readSQL(
        operation,
        'select file_id::text,owner_type,owner_id from labos_threejs_core.file_references order by file_id,owner_type,owner_id',
      ),
      recordings: present[0].recordings
        ? await db!.readSQL(
            operation,
            'select id::text,session_id::text,status from lab.recordings order by id',
          )
        : [],
      resources: present[0].recordings
        ? await db!.readSQL(
            operation,
            'select recording_id::text,file_id::text,role from lab.recording_resources order by recording_id,file_id,role',
          )
        : [],
    };
  } finally {
    await close();
  }
}

async function application(mode: 'old' | 'current'): Promise<Application> {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/recording-legacy-process.ts';
  target.env = {
    APP_ORIGIN: target.url,
    FILE_PUBLIC_ORIGIN: target.url,
    RATE_LIMIT_ENABLED: 'false',
    LAB_WORD_SYNTHETIC_SESSION: 'true',
    LAB_WORD_MOTION_GRACE_MS: '60000',
    RECORDING_LEGACY_MODE: mode,
  };
  try {
    await target.start();
    const api = new CoreHttp(target.url);
    const email = `legacy-recording-${randomUUID()}@example.test`;
    await api.register(email);
    const lab = await api.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Actual schema-v3 Recording adoption' },
      201,
    );
    const bytes = await readFile(
      new URL('../fixtures/lab/cube.glb', import.meta.url),
    );
    const asset = await publishAsset(
      api,
      bytes,
      'Exact pre-Recording dependency',
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
      { name: 'Legacy fixture independent Machine' },
      201,
    );
    return {
      target,
      api,
      email,
      lab: lab.id,
      asset,
      installation,
      machine,
      bytes,
    };
  } catch (error) {
    await target.cleanup();
    throw error;
  }
}

async function oldFixture(): Promise<LegacyFixture> {
  const f = await application('old');
  const { target, api, lab, installation, machine } = f;
  try {
    const started = await api.json<SimulationSession>(
      'POST',
      sessionPath(lab),
      { installation_id: installation.id, machine_id: machine.machine.id },
      201,
    );
    assert.equal(started.status, 'starting');
    await api.json('POST', sessionPath(lab, started.id) + '/stop', {
      expected_revision: started.revision,
    });
    const session = await recordingEventually(
      () => api.json<SimulationSession>('GET', sessionPath(lab, started.id)),
      (value) => !!value.ended_at,
    );
    assert.equal(session.status, 'interrupted');
    assert.equal(session.reason, 'source_ack_timeout');
    assert.deepEqual(session.snapshot, started.snapshot);
    assert.equal((await api.response('GET', recordingPath(lab))).status, 404);
    await target.stop();
    return { ...f, session };
  } catch (error) {
    await target.cleanup();
    throw error;
  }
}

async function reopen(f: LegacyFixture, mode: 'current' | 'quota') {
  f.target.env.RECORDING_LEGACY_MODE = mode;
  await f.target.start();
  await f.api.login(f.email);
  const ready = await f.api.response('GET', '/health/ready');
  assert.equal(ready.status, 200);
  await ready.arrayBuffer();
}

async function dependencyBytes(f: LegacyFixture) {
  const download = await f.api.json<DownloadCapability>(
    'GET',
    `/api/v1/lab/assets/${f.asset.id}/download`,
  );
  assert.equal(download.file.id, f.asset.representation.file_id);
  assert.equal(download.file.sha256, digest(f.bytes).slice(7));
  const response = await fetch(download.url, {
    signal: AbortSignal.timeout(10000),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
}

function originalPins(f: LegacyFixture, inventory: Custody) {
  assert.deepEqual(inventory.sessionAssets, [
    {
      session_id: f.session.id,
      representation_id: f.asset.representation.id,
      file_id: f.asset.representation.file_id,
    },
  ]);
  assert.equal(inventory.sessions.length, 1);
  assert.deepEqual(inventory.sessions[0].snapshot, f.session.snapshot);
  assert(inventory.sessions[0].ended_at);
}

async function adopted(f: LegacyFixture) {
  const metadata = await recordingForSession(f.api, f.lab, f.session.id);
  const saved = await publicRecording(f.api, f.lab, metadata.id);
  assert.equal(saved.metadata.status, 'incomplete');
  assert.equal(saved.metadata.integrity, 'incomplete');
  assert.equal(saved.metadata.reason, 'reliable_capture_unavailable_at_start');
  assert.equal(saved.metadata.snapshot_hash, f.session.snapshot.hash);
  assert.equal(saved.manifest.snapshot_hash, f.session.snapshot.hash);
  assert.deepEqual(saved.manifest.snapshot, f.session.snapshot);
  assert.equal(saved.metadata.prefix.source_packet_sequence, '0');
  assert.equal(saved.metadata.prefix.last_source_sequence, '0');
  assert.equal(saved.metadata.prefix.last_source_event_sequence, '0');
  assert.equal(saved.metadata.prefix.source_ended, false);
  assert.equal(
    saved.records.filter((record) => record.kind.startsWith('source.')).length,
    0,
  );
  assert(saved.segments.length > 0);
  assert(saved.segments.every((segment) => segment.sealed && segment.file_id));
  assert(saved.events.length > 0);
  assert(saved.events.every((event) => event.event_type === 'session.changed'));
  await dependencyBytes(f);
  const sessions = await f.api.json<{
    active_session_id: string | null;
    data: SimulationSession[];
  }>('GET', sessionPath(f.lab));
  assert.equal(sessions.active_session_id, null);
  assert.equal(sessions.data.length, 1);
  assert.deepEqual(sessions.data[0], f.session);
  return saved;
}

test(
  'recording genuine schema-v3 ended Session adopts exact snapshot and dependency custody without replay across two reopens',
  { timeout: 120000 },
  async () => {
    const f = await oldFixture();
    try {
      const before = await custody(f.target);
      assert.equal(before.schemaVersion, 3);
      assert.equal(before.recordings.length, 0);
      originalPins(f, before);
      await reopen(f, 'current');
      const saved = await adopted(f);
      for (const target of f.installation.targets)
        await f.api.json(
          'PUT',
          `/api/v1/lab/labs/${f.lab}/entities/${target.entity_id}/appearance`,
          { representation_id: null },
        );
      await f.api.json('POST', `/api/v1/lab/labs/${f.lab}/history/cleanup`);
      assert.equal(
        (await f.api.response('DELETE', `/api/v1/lab/assets/${f.asset.id}`))
          .status,
        409,
      );
      await dependencyBytes(f);
      assert.deepEqual(
        await publicRecording(f.api, f.lab, saved.metadata.id),
        saved,
      );
      await f.target.stop();
      const after = await custody(f.target);
      assert.equal(after.schemaVersion, 4);
      assert.deepEqual(after.history.slice(0, 3), before.history);
      assert.deepEqual(after.sessionAssets, []);
      assert.deepEqual(
        after.resources.filter((resource) => resource.role === 'dependency'),
        [
          {
            recording_id: saved.metadata.id,
            file_id: f.asset.representation.file_id,
            role: 'dependency',
          },
        ],
      );
      assert(
        after.references.some(
          (reference) =>
            reference.file_id === f.asset.representation.file_id &&
            reference.owner_type === 'lab.recording' &&
            reference.owner_id === saved.metadata.id,
        ),
      );
      await reopen(f, 'current');
      assert.deepEqual(await adopted(f), saved);
      await f.target.stop();
      const second = await custody(f.target);
      assert.deepEqual(second, after);
      recordingReceipt('recording-legacy-adoption', {
        fixture:
          'genuine immutable migration prefix / public pre-Recording branches',
        baseline: 'c80e63c8c063e44ca80c85970b518c35fb448c8e',
        before,
        after,
        second,
        snapshot_hash: f.session.snapshot.hash,
        exactDependencyBytes: f.bytes.length,
        exactSealedSegments: saved.segments,
        noReplay: true,
        secondReopen: true,
      });
    } finally {
      await cleanup(f.target);
    }
  },
);

test(
  'recording legacy adoption quota preserves original Session pins and bytes and refuses new admission until honest retry',
  { timeout: 120000 },
  async () => {
    const f = await oldFixture();
    try {
      const before = await custody(f.target);
      assert.equal(before.schemaVersion, 3);
      originalPins(f, before);
      await reopen(f, 'quota');
      const list = await f.api.json<{ data: unknown[] }>(
        'GET',
        recordingPath(f.lab),
      );
      assert.deepEqual(list.data, []);
      await dependencyBytes(f);
      await f.api.error(
        'POST',
        sessionPath(f.lab),
        {
          installation_id: f.installation.id,
          machine_id: f.machine.machine.id,
        },
        503,
        'lab.recording_unavailable',
      );
      assert.equal(
        (
          await f.api.json<{ active_session_id: string | null }>(
            'GET',
            sessionPath(f.lab),
          )
        ).active_session_id,
        null,
      );
      for (const target of f.installation.targets)
        await f.api.json(
          'PUT',
          `/api/v1/lab/labs/${f.lab}/entities/${target.entity_id}/appearance`,
          { representation_id: null },
        );
      await f.api.json('POST', `/api/v1/lab/labs/${f.lab}/history/cleanup`);
      assert.equal(
        (await f.api.response('DELETE', `/api/v1/lab/assets/${f.asset.id}`))
          .status,
        409,
      );
      await dependencyBytes(f);
      await f.target.stop();
      const refused = await custody(f.target);
      assert.equal(refused.schemaVersion, 4);
      assert.deepEqual(refused.history.slice(0, 3), before.history);
      originalPins(f, refused);
      assert.deepEqual(refused.references, before.references);
      assert.deepEqual(refused.recordings, []);
      assert.deepEqual(refused.resources, []);
      await reopen(f, 'current');
      const saved = await adopted(f);
      await f.target.stop();
      const after = await custody(f.target);
      assert.deepEqual(after.sessionAssets, []);
      assert.equal(after.recordings.length, 1);
      await reopen(f, 'current');
      assert.deepEqual(await adopted(f), saved);
      recordingReceipt('recording-legacy-quota', {
        before,
        refused,
        after,
        quota: { maxTotalBytes: 1, scopedToOwnedChild: true },
        oldPinsAndExactBytesPreserved: true,
        noNewSessionAccepted: true,
        recoveryWithoutFabrication: true,
        secondReopen: true,
      });
    } finally {
      await cleanup(f.target);
    }
  },
);

type SqlReceipt = DbMeasurement & { event: 'database.operation' };
function sqlReceipts(logs: string): SqlReceipt[] {
  return logs.split('\n').flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row.event === 'database.operation' ? [row as SqlReceipt] : [];
    } catch {
      return [];
    }
  });
}

// Reuse the independently validated oracle; calendar seconds and fractional
// microseconds are normalized separately, without a production time helper.
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

test('recording timestamp oracle preserves six digits and distinguishes UTC offset year boundaries', () => {
  const expected = '2026-12-31T23:59:59.123456Z';
  for (const offset of ['+08', '+0800', '+08:00'])
    assert.equal(exactTime('2027-01-01 07:59:59.123456' + offset), expected);
  assert.equal(exactTime(expected), expected);
  assert.notEqual(exactTime('2027-01-01 07:59:59.123457+08'), expected);
  assert.equal(
    exactTime('2026-12-31 16:00:00.000001-08'),
    '2027-01-01T00:00:00.000001Z',
  );
  assert.equal(
    exactTime('2027-01-01T00:00:00.000001Z'),
    '2027-01-01T00:00:00.000001Z',
  );
});

test(
  'recording active Command capture reports the whole HTTP SQL operation and exact accepted fact without changing no-Recording budgets',
  { timeout: 120000 },
  async () => {
    const f = await application('current');
    try {
      const light = await f.api.json<{ id: string }>(
        'POST',
        `/api/v1/lab/labs/${f.lab}/entities`,
        {
          name: 'Measured Recording command',
          definition_id: 'light',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
        },
        201,
      );
      const entityPath = `/api/v1/lab/labs/${f.lab}/entities/${light.id}`;
      await f.api.json('POST', entityPath + '/program/start', undefined, 201);
      async function command(on: boolean) {
        const response = await f.api.response(
          'POST',
          entityPath + '/actions',
          {
            capability: 'light.set_power',
            parameters: { on },
          },
          { 'idempotency-key': randomUUID() },
        );
        assert.equal(response.status, 202);
        const accepted = (await response.json()) as DeviceCommand;
        const requestId = response.headers.get('x-request-id');
        assert(requestId);
        const receipt = await recordingEventually(
          () => sqlReceipts(f.target.logs).find((row) => row.id === requestId),
          Boolean,
        );
        assert(receipt && receipt.kind === 'request');
        assert.equal(receipt.statements, receipt.commands.length);
        assert(
          receipt.commands.includes('BEGIN') &&
            receipt.commands.includes('COMMIT'),
        );
        return { accepted, requestId, receipt };
      }
      const baseline = await command(false);
      assert(!baseline.receipt.commands.includes('ROLLBACK'));
      const starting = await f.api.json<SimulationSession>(
        'POST',
        sessionPath(f.lab),
        {
          installation_id: f.installation.id,
          machine_id: f.machine.machine.id,
        },
        201,
      );
      const admission = await new CoreHttp(f.target.url, {
        authorization: 'Bearer ' + f.machine.credential,
      }).json<RecordingAdmission>(
        'POST',
        sessionPath(f.lab, starting.id) + '/publisher-admissions',
        {
          machine_id: f.machine.machine.id,
        },
        201,
      );
      const session = await f.api.json<SimulationSession>(
        'GET',
        sessionPath(f.lab, starting.id),
      );
      const machine = new RecordingMachine(session, admission, f.target.url);
      await machine.ready();
      const initial = selectedFrame(session, 1n, 0n);
      await machine.capture([initial]);
      machine.liveFrame(initial);
      await recordingEventually(
        () =>
          f.api.json<SimulationSession>('GET', sessionPath(f.lab, session.id)),
        (value) => value.status === 'running',
      );
      const observedStart = f.target.logs.length;
      const active = await command(true);
      assert.equal(active.accepted.status, 'accepted');
      assert(
        active.receipt.commands.includes('ROLLBACK'),
        'Active capture must include the real planning rollback in its whole HTTP receipt',
      );
      const recording = await recordingForSession(f.api, f.lab, session.id);
      const page = await f.api.json<{
        data: RecordingEvent[];
        next_cursor: string | null;
      }>('GET', recordingPath(f.lab, recording.id) + '/events?limit=100');
      assert(page.data.length <= 100);
      assert.equal(
        page.next_cursor,
        null,
        'This bounded fixture must inspect its entire admitted event prefix',
      );
      const acceptedEvents = page.data.filter(
        (event) =>
          event.event_type === 'command.changed' &&
          (event.event.command as Record<string, unknown>).id ===
            active.accepted.id &&
          (event.event.command as Record<string, unknown>).status ===
            'accepted',
      );
      assert.equal(acceptedEvents.length, 1);
      assert.equal(acceptedEvents[0].sim_time_ns, null);
      const fact = acceptedEvents[0].event.command as Record<string, unknown>;
      for (const [key, value] of Object.entries(active.accepted))
        assert.deepEqual(exactTime(fact[key]), exactTime(value), key);
      const window = sqlReceipts(f.target.logs.slice(observedStart));
      assert.equal(
        window.filter((row) => row.id === active.requestId).length,
        1,
      );
      recordingReceipt('recording-active-sql', {
        baseline: baseline.receipt,
        active: active.receipt,
        background: window.filter((row) => row.kind === 'background'),
        publicAcceptedFact: acceptedEvents[0],
        planningRollbackIncluded: true,
        authenticationAndApplyWitnessIncluded: true,
        limitPolicy:
          'Observed costs only; existing no-Recording numeric budgets are unchanged',
        ownership: {
          supervisor_ledger: f.target.evidence + '/owned-resources.json',
          port: f.target.port,
        },
      });
    } finally {
      try {
        await closeRecordingSockets();
      } finally {
        await cleanup(f.target);
      }
    }
  },
);
