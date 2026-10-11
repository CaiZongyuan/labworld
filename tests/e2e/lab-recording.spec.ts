import { test, expect, type BrowserContext } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  processIdentity,
  type ProcessIdentity,
} from '../support/server-resources.ts';
import type {
  DeviceCommand,
  DeviceTask,
  DeviceTaskResult,
  SimulationSession,
} from '../../packages/contracts/src/generated/types.gen';
import {
  assertSessionGeometry,
  assertSessionFrame,
  readSessionFrame,
} from './simulation-session-oracle';
import {
  prepareSession,
  action,
  authority,
  pose,
  pixels,
  lifecycle,
  SessionWire,
  closeSessionSockets,
  world,
} from './simulation-session-support';
import {
  publicRecording,
  recordingEventually,
  recordingForSession,
  recordingPath,
  recordingReceipt,
  recordingStage,
  type RecordingMetadata,
} from './recording-public-support';
import {
  recordedFrames,
  recordedSourcePackets,
  selectedFrame,
} from './recording-wire-oracle';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });

test('recording journey: real Python and two WebGL views preserve paused physics, real device time, Reset recordings and public tutorial bytes', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  const contexts: BrowserContext[] = [];
  let active: SimulationSession | undefined;
  let fixture: Awaited<ReturnType<typeof prepareSession>> | undefined;
  recordingStage('recording-real-journey-start', {
    scope:
      'synthetic; two real desktop WebGL views; no Newton/remote/power-loss claim',
  });
  try {
    const f = await prepareSession(page, browser);
    fixture = f;
    contexts.push(f.secondContext);
    const device = await f.api.json<{ id: string }>(
      'POST',
      `/api/v1/lab/labs/${f.lab.id}/entities`,
      {
        name: 'Recording ordinary centrifuge',
        definition_id: 'centrifuge',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: { initial_temperature: 22 },
      },
      201,
    );
    const devicePath = `/api/v1/lab/labs/${f.lab.id}/entities/${device.id}`;
    await f.api.json('POST', devicePath + '/program/start', undefined, 201);
    const before = await world(f.api, f.lab.id);
    const wireA = new SessionWire(page),
      wireB = new SessionWire(f.second);
    const started = await action(page, f.lab.id, null, 'Start');
    active = started;
    const running = await authority(f.api, f.lab.id, started.id, 'running');
    active = running;
    const recordingA = await recordingForSession(f.api, f.lab.id, running.id);
    assert.equal(recordingA.snapshot_hash, running.snapshot.hash);
    const firstA = await pose(page, running.id),
      firstB = await pose(f.second, running.id);
    assertSessionGeometry(firstA, running);
    assertSessionGeometry(firstB, running);
    for (const viewer of [page, f.second]) {
      await pixels(
        viewer,
        'recording-exposed-' + (viewer === page ? 'a' : 'b'),
      );
      await lifecycle(viewer, 'running');
    }
    const command = await f.api.json<DeviceCommand>(
      'POST',
      devicePath + '/actions',
      {
        capability: 'centrifuge.start',
        parameters: { rpm: 500, temperature: 22, duration_seconds: 12 },
      },
      202,
      { 'idempotency-key': randomUUID() },
    );
    assert(command.task_id);
    const taskPath = devicePath + '/tasks/' + command.task_id;
    const task = await recordingEventually(
      () => f.api.json<DeviceTask>('GET', taskPath),
      (value) => value.status === 'running',
      10000,
    );
    await action(page, f.lab.id, running.id, 'Pause');
    const paused = await authority(f.api, f.lab.id, running.id, 'paused');
    active = paused;
    const frozenA = await pose(page, running.id),
      frozenB = await pose(f.second, running.id);
    assert.equal(frozenA.nodes[0].sim_time_ns, frozenB.nodes[0].sim_time_ns);
    const progressed = await recordingEventually(
      () => f.api.json<DeviceTask>('GET', taskPath),
      (value) => value.elapsed_seconds >= task.elapsed_seconds + 2,
      8000,
    );
    assert(
      ['running', 'decelerating', 'completed'].includes(progressed.status),
    );
    const afterA = await pose(page, running.id),
      afterB = await pose(f.second, running.id);
    assert.equal(afterA.nodes[0].sim_time_ns, frozenA.nodes[0].sim_time_ns);
    assert.equal(afterB.nodes[0].sim_time_ns, frozenB.nodes[0].sim_time_ns);
    assertSessionGeometry(afterA, paused);
    assertSessionGeometry(afterB, paused);
    for (const viewer of [page, f.second]) await lifecycle(viewer, 'paused');
    const successor = await action(page, f.lab.id, paused.id, 'Reset');
    active = successor;
    assert.notEqual(successor.id, running.id);
    assert.equal(successor.snapshot.hash, running.snapshot.hash);
    const next = await authority(f.api, f.lab.id, successor.id, 'running');
    active = next;
    for (const viewer of [page, f.second])
      assertSessionGeometry(await pose(viewer, next.id), next);
    const recordingB = await recordingForSession(f.api, f.lab.id, next.id);
    assert.notEqual(recordingB.id, recordingA.id);
    const manifestB = await f.api.json<{
      snapshot_hash: string;
      capture_baseline: { entities: { id: string; task?: DeviceTask }[] };
    }>('GET', recordingPath(f.lab.id, recordingB.id) + '/manifest');
    assert.equal(manifestB.snapshot_hash, running.snapshot.hash);
    const capturedTask = manifestB.capture_baseline.entities.find(
      (entity) => entity.id === device.id,
    )?.task;
    assert(capturedTask);
    assert.equal(capturedTask.id, task.id);
    assert(capturedTask.elapsed_seconds >= progressed.elapsed_seconds);
    const finished = await recordingEventually(
      () => f.api.json<DeviceTask>('GET', taskPath),
      (value) => value.status === 'completed',
      20000,
    );
    const result = await f.api.json<DeviceTaskResult>(
      'GET',
      devicePath + '/results/' + finished.result_id,
    );
    assert.equal(result.status, 'completed');
    await action(page, f.lab.id, next.id, 'Pause');
    active = await authority(f.api, f.lab.id, next.id, 'paused');
    assertSessionFrame(next, wireA.get(next.id)!.latest!);
    assertSessionFrame(next, wireB.get(next.id)!.latest!);
    await action(page, f.lab.id, next.id, 'Resume');
    active = await authority(f.api, f.lab.id, next.id, 'running');
    await action(page, f.lab.id, next.id, 'Stop');
    active = await authority(f.api, f.lab.id, next.id, 'stopped');
    for (const recording of [recordingA, recordingB])
      await recordingEventually(
        () =>
          f.api.json<RecordingMetadata>(
            'GET',
            recordingPath(f.lab.id, recording.id),
          ),
        (value) => value.status === 'complete',
        10000,
      );
    const a = await publicRecording(f.api, f.lab.id, recordingA.id),
      b = await publicRecording(f.api, f.lab.id, recordingB.id);
    for (const [session, readback] of [
      [running, a],
      [next, b],
    ] as const) {
      const frames = recordedFrames(recordedSourcePackets(readback.records));
      assert(frames.length > 2);
      assert.deepEqual(frames[0], selectedFrame(session, 1n, 0n));
      frames.forEach((bytes, index) => {
        assert.equal(bytes.readBigUInt64LE(16), BigInt(index + 1));
        assertSessionFrame(session, readSessionFrame(bytes));
        if (index)
          assert(
            bytes.readBigUInt64LE(24) >= frames[index - 1].readBigUInt64LE(24),
          );
      });
      assert.equal(readback.metadata.prefix.source_ended, true);
      assert.equal(readback.manifest.snapshot_hash, running.snapshot.hash);
    }
    assert(
      a.events.some(
        (event) =>
          event.event_type === 'lifecycle.applied' &&
          event.event.action === 'stop',
      ),
    );
    assert(
      b.events.some(
        (event) =>
          event.event_type === 'task.changed' &&
          (event.event.result as { status?: string } | undefined)?.status ===
            'completed',
      ),
    );
    assert(
      [...a.events, ...b.events]
        .filter((event) => event.entity_id === device.id)
        .every((event) => event.sim_time_ns === null),
    );
    const saved = await world(f.api, f.lab.id);
    assert.deepEqual(saved.nodes, before.nodes);
    assert.deepEqual(saved.relationships, before.relationships);
    // Execute the exact published teaching file in a real authenticated page.
    await page.addScriptTag({
      content: readFileSync('docs/examples/recording-inspection.js', 'utf8'),
    });
    const inspected = await page.evaluate(
      async ({ lab, recording }) => {
        const api = globalThis as typeof globalThis & {
          inspectRecording: (
            lab: string,
            id: string,
          ) => Promise<{
            status: string;
            integrity: string;
            verified_segment_id: string | null;
            source_header?: unknown;
          }>;
        };
        return api.inspectRecording(lab, recording);
      },
      { lab: f.lab.id, recording: recordingB.id },
    );
    assert.equal(inspected.status, 'complete');
    assert.equal(inspected.integrity, 'complete');
    assert(inspected.verified_segment_id);
    const retainedSegments = b.segments;
    await page.evaluate(
      async ({ lab, recording }) => {
        const api = globalThis as typeof globalThis & {
          deleteRecording: (lab: string, id: string) => Promise<void>;
        };
        await api.deleteRecording(lab, recording);
      },
      { lab: f.lab.id, recording: recordingA.id },
    );
    assert.equal(
      (await f.api.response('GET', recordingPath(f.lab.id, recordingA.id)))
        .status,
      404,
    );
    assert.deepEqual(
      (await publicRecording(f.api, f.lab.id, recordingB.id)).segments,
      retainedSegments,
    );
    const crashed = await action(page, f.lab.id, null, 'Start');
    active = await authority(f.api, f.lab.id, crashed.id, 'running');
    await pose(page, crashed.id);
    await pose(f.second, crashed.id);
    const serverLedger = JSON.parse(
      readFileSync(
        join(dirname(process.env.E2E_API_PID_FILE!), 'owned-resources.json'),
        'utf8',
      ),
    ) as { directory: string };
    const sourcePath = join(
      serverLedger.directory,
      'runtime',
      'synthetic-sources',
      crashed.id + '.json',
    );
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as {
      owner: string;
      session_id: string;
      creator: ProcessIdentity;
      process: ProcessIdentity;
      state: string;
    };
    assert.equal(source.owner, 'lab-word-synthetic-session-v1');
    assert.equal(source.session_id, crashed.id);
    assert.equal(
      source.creator.pid,
      Number(readFileSync(process.env.E2E_API_PID_FILE!, 'utf8').trim()),
    );
    assert.deepEqual(await processIdentity(source.process.pid), source.process);
    process.kill(source.process.pid, 'SIGKILL');
    active = await authority(f.api, f.lab.id, crashed.id, 'interrupted');
    const crashedRecording = await recordingForSession(
      f.api,
      f.lab.id,
      crashed.id,
    );
    await recordingEventually(
      () =>
        f.api.json<RecordingMetadata>(
          'GET',
          recordingPath(f.lab.id, crashedRecording.id),
        ),
      (value) => value.status === 'incomplete',
      10000,
    );
    await recordingEventually(
      () => processIdentity(source.process.pid),
      (identity) => identity === undefined,
    );
    await recordingEventually(
      () => JSON.parse(readFileSync(sourcePath, 'utf8')).state as string,
      (state) => state === 'cleaned',
    );
    assert.deepEqual(
      await f.api.json<DeviceTaskResult>(
        'GET',
        devicePath + '/results/' + finished.result_id,
      ),
      result,
    );
    for (const viewer of [page, f.second])
      await lifecycle(viewer, 'interrupted');
    await expect(page.getByRole('button', { name: /^仿真会话/ })).toBeVisible();
    recordingReceipt('recording-real-two-viewer-proof', {
      sessions: [running.id, next.id],
      recordings: [recordingA.id, recordingB.id],
      snapshotHash: running.snapshot.hash,
      pausedSimTime: frozenA.nodes[0].sim_time_ns,
      ordinaryElapsedBefore: task.elapsed_seconds,
      ordinaryElapsedDuringPause: progressed.elapsed_seconds,
      completedResult: result.id,
      teachingFile: 'docs/examples/recording-inspection.js',
      deletedOnlyA: true,
      knownInitialBoundaryAndTrajectory: true,
      independentAllSelectedPythonSchedule: false,
      actualSupervisedSourceSigkill: true,
      sourceLedger: sourcePath,
    });
    recordingStage('recording-real-journey-pass');
  } finally {
    if (fixture && active && !active.ended_at) {
      const current = await fixture.api
        .json<SimulationSession>(
          'GET',
          `/api/v1/lab/labs/${fixture.lab.id}/sessions/${active.id}`,
        )
        .catch(() => undefined);
      if (current && !current.ended_at)
        await fixture.api
          .response(
            'POST',
            `/api/v1/lab/labs/${fixture.lab.id}/sessions/${current.id}/stop`,
            { expected_revision: current.revision },
          )
          .catch(() => undefined);
    }
    await closeSessionSockets();
    for (const context of contexts) await context.close();
    recordingStage('recording-real-journey-owned-consumers-closed');
  }
});
