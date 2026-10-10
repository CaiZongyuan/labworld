import { test, expect, type BrowserContext } from '@playwright/test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type {
  SimulationSession,
  SessionMotionTicket,
} from '../../packages/contracts/src/generated/types.gen';
import { assertAdvanced } from './motion-oracle';
import { verifyMachineAuthority } from './simulation-session-machine';
import {
  assertSessionGeometry,
  assertSessionFrame,
} from './simulation-session-oracle';
import {
  prepareSession,
  action,
  authority,
  pose,
  dialog,
  lifecycle,
  select,
  world,
  savedLayout,
  layoutInput,
  sessionPath,
  sessionsPath,
  SessionWire,
  SessionRawViewer,
  pauseBoundary,
  maskedCanvas,
  leaveSession,
  observeSession,
  openLab,
  closeSessionSockets,
  appearancePixels,
  resourceCounts,
  settledResourceCounts,
  expectInitialSceneReady,
  reopenOwnedApi,
  eventually,
  receipt,
  stage,
  pixels,
  metrics,
  displayed,
} from './simulation-session-support';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });

test('session machine authority: public credentials, immutable bootstrap, lease scope, new ACK boundaries and revocation', async () => {
  test.setTimeout(90000);
  await verifyMachineAuthority();
});

test('session lifecycle: real Python and two frozen GLB views follow authoritative pause, reset, saved edits and recovery', async ({
  page,
  browser,
}) => {
  test.setTimeout(240000);
  stage('session-journey-start', {
    product: process.env.MOTION_E2E_PRODUCT_COMMIT,
    scope: 'development-synthetic; no Recording/Newton/remote claim',
  });
  const contexts: BrowserContext[] = [],
    sockets: SessionRawViewer[] = [];
  let phase = 'public-install';
  const errors: string[] = [];
  let cleanupFailures: unknown[];
  try {
    const f = await prepareSession(page, browser);
    contexts.push(f.secondContext);
    const wireA = new SessionWire(page),
      wireB = new SessionWire(f.second);
    for (const viewer of [page, f.second])
      viewer.on('pageerror', (error) => errors.push(error.name));
    receipt('session-installations', {
      main: f.installation,
      otherLab: f.independent,
      sourceObjects: 20,
      sameViewerOverlapAvoided: true,
    });
    phase = 'shared-start';
    const started = await action(page, f.lab.id, null, 'Start');
    const running = await authority(f.api, f.lab.id, started.id, 'running');
    assert.equal(running.snapshot.installation.id, f.installation.id);
    assert.deepEqual(running.snapshot.world.nodes, f.before.nodes);
    assert.deepEqual(
      running.snapshot.world.relationships,
      f.before.relationships,
    );
    const conflict = await f.api.response('POST', sessionsPath(f.lab.id), {
      installation_id: f.installation.id,
    });
    expect(conflict.status).toBe(409);
    await conflict.arrayBuffer();
    const active = await f.api.json<{ active_session_id: string }>(
      'GET',
      sessionsPath(f.lab.id),
    );
    assert.equal(active.active_session_id, running.id);
    const controls = await dialog(f.second);
    await controls.getByLabel('接收频率', { exact: true }).selectOption('15');
    await controls.getByRole('button', { name: '关闭', exact: true }).click();
    const initialA = await pose(page, running.id),
      initialB = await pose(f.second, running.id);
    const initialAppearance = [
      await appearancePixels(page, 'session-initial-green-a'),
      await appearancePixels(f.second, 'session-initial-green-b'),
    ];
    for (const value of initialAppearance) {
      assert(value.green > 80);
      assert.equal(value.purple, 0);
    }
    const firstChecks = [
      assertSessionGeometry(initialA, running),
      assertSessionGeometry(initialB, running),
    ];
    const advancedA = await eventually(
      () => pose(page, running.id),
      (value) =>
        BigInt(value.nodes[0].sim_time_ns) -
          BigInt(initialA.nodes[0].sim_time_ns) >=
        1_000_000_000n,
    );
    const advancedB = await pose(f.second, running.id);
    const movement = [
      assertAdvanced(initialA, advancedA),
      assertAdvanced(initialB, advancedB),
    ];
    assertSessionGeometry(advancedA, running);
    assertSessionGeometry(advancedB, running);
    assertSessionFrame(running, wireA.get(running.id)!.latest!);
    assertSessionFrame(running, wireB.get(running.id)!.latest!);
    const exposed = [
      await pixels(page, 'session-moving-a'),
      await pixels(f.second, 'session-moving-b'),
    ];
    for (const viewer of [page, f.second]) {
      await lifecycle(viewer, 'running');
      const render = await metrics(viewer);
      expect(
        Number(render.stats['三角形'].replaceAll(',', '')),
      ).toBeGreaterThan(200);
    }
    const unchanged = await world(f.api, f.lab.id);
    assert.deepEqual(unchanged.nodes, f.before.nodes);
    assert.deepEqual(unchanged.relationships, f.before.relationships);
    receipt('session-start-real-source', {
      id: running.id,
      snapshotHash: running.snapshot.hash,
      epoch: running.epoch,
      firstChecks,
      movement,
      exposed,
      render: [await metrics(page), await metrics(f.second)],
      wire: [wireA.get(running.id), wireB.get(running.id)],
      savedWorldUnchanged: true,
    });

    phase = 'pause-final-boundary';
    await action(page, f.lab.id, running.id, 'Pause');
    const paused = await authority(f.api, f.lab.id, running.id, 'paused');
    const boundary = await pauseBoundary(f.api, f.lab.id, paused, sockets);
    const pausedA = await pose(page, paused.id, boundary),
      pausedB = await pose(f.second, paused.id, boundary);
    const pauseChecks = [
      assertSessionGeometry(pausedA, paused, boundary),
      assertSessionGeometry(pausedB, paused, boundary),
    ];
    for (const viewer of [page, f.second]) await lifecycle(viewer, 'paused');
    const lateContext = await browser.newContext({
      storageState: await page.context().storageState(),
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(lateContext);
    const late = await lateContext.newPage();
    await late.goto(`/lab?lab=${f.lab.id}`);
    await expectInitialSceneReady(late.locator('.world-page'));
    const latePose = await pose(late, paused.id, boundary);
    assertSessionGeometry(latePose, paused, boundary);
    await lifecycle(late, 'paused');
    const pauseAt = performance.now();
    await eventually(
      async () => ({
        session: await f.api.json<SimulationSession>(
          'GET',
          sessionPath(f.lab.id, paused.id),
        ),
        seconds: (performance.now() - pauseAt) / 1000,
      }),
      (value) => value.seconds >= 6 && value.session.status === 'paused',
    );
    for (const viewer of [page, f.second, late])
      assertSessionGeometry(
        await pose(viewer, paused.id, boundary),
        paused,
        boundary,
      );
    receipt('session-pause-boundary', {
      id: paused.id,
      boundary,
      pauseChecks,
      lateJoinNodes: latePose.nodes.length,
      pausedSeconds: (performance.now() - pauseAt) / 1000,
      at15Hz: true,
      heartbeatAndFreshnessGraceSeparated: true,
    });
    await lateContext.close();

    phase = 'independent-camera-selection';
    const firstEntity = running.snapshot.world.entities.find(
      (e) => e.id === running.snapshot.installation.targets[0].entity_id,
    )!;
    const secondEntity = running.snapshot.world.entities.find(
      (e) => e.id === running.snapshot.installation.targets[1].entity_id,
    )!;
    await select(page, firstEntity.name);
    await select(f.second, secondEntity.name);
    const imageA = await maskedCanvas(page),
      imageB = await maskedCanvas(f.second);
    const rect = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.wheel(0, -180);
    await expect.poll(() => maskedCanvas(page)).not.toBe(imageA);
    expect(await maskedCanvas(f.second)).toBe(imageB);
    await expect(
      page.getByRole('complementary', { name: '对象信息' }),
    ).toContainText(firstEntity.name);
    await expect(
      f.second.getByRole('complementary', { name: '对象信息' }),
    ).toContainText(secondEntity.name);

    phase = 'leave-observe-and-resource-convergence';
    await leaveSession(f.second);
    assert.equal(
      (
        await f.api.json<SimulationSession>(
          'GET',
          sessionPath(f.lab.id, paused.id),
        )
      ).status,
      'paused',
    );
    await observeSession(f.second);
    assertSessionGeometry(
      await pose(f.second, paused.id, boundary),
      paused,
      boundary,
    );
    await select(f.second, secondEntity.name);
    const selectedResources = await settledResourceCounts(f.second);
    const originalCanvas = (await f.second.locator('canvas').elementHandle())!;
    const convergence: unknown[] = [
      { phase: 'selected-paused-scene', ...selectedResources },
    ];
    for (let iteration = 0; iteration < 2; iteration++) {
      await openLab(f.second, f.emptyLab);
      const emptyResources = await eventually(
        () => resourceCounts(f.second),
        (value) =>
          value.geometries < selectedResources.geometries &&
          value.textures <= selectedResources.textures,
      );
      const returnedScene = await openLab(f.second, f.lab, {
        sceneInitialization: true,
      });
      const returnedPose = await pose(f.second, paused.id, boundary);
      const returnGeometry = assertSessionGeometry(
        returnedPose,
        paused,
        boundary,
      );
      const returnedPixels = await pixels(
        f.second,
        `session-lab-return-${iteration}-pixels`,
      );
      receipt(`session-lab-return-${iteration}-result`, {
        witness: returnedScene,
        geometry: returnGeometry,
        pixels: returnedPixels,
        sourceNodes: returnedPose.nodes.length,
      });
      await select(f.second, secondEntity.name);
      const returningControls = await dialog(f.second);
      await returningControls
        .getByLabel('接收频率', { exact: true })
        .selectOption('15');
      await returningControls
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      const returned = await eventually(
        () => resourceCounts(f.second),
        (value) =>
          value.geometries === selectedResources.geometries &&
          value.textures === selectedResources.textures,
      );
      assertSessionGeometry(
        await pose(f.second, paused.id, boundary),
        paused,
        boundary,
      );
      convergence.push({
        iteration,
        emptyResources,
        returned,
        selection: secondEntity.id,
        originalCanvasRetained: await originalCanvas.evaluate(
          (canvas) => canvas.isConnected,
        ),
      });
      receipt('session-resource-convergence', convergence);
    }
    await originalCanvas.dispose();

    phase = 'saved-placement-frozen-render';
    const frozenImage = await maskedCanvas(f.second),
      edited = await world(f.api, f.lab.id),
      editedNode = edited.nodes.find(
        (n) => n.id === f.installation.targets[0].node_id,
      )!;
    editedNode.placement = {
      ...editedNode.placement,
      position: [
        editedNode.placement.position[0] + 1.25,
        editedNode.placement.position[1],
        editedNode.placement.position[2],
      ],
      rotation: [0, -0.4, 0],
      scale: [0.8, 1.2, 0.9],
    };
    let saved = await savedLayout(f.api, f.lab.id, edited);
    assertSessionGeometry(
      await pose(f.second, paused.id, boundary),
      paused,
      boundary,
    );
    expect(await maskedCanvas(f.second)).toBe(frozenImage);
    const pinnedAppearance = await appearancePixels(
      f.second,
      'session-active-pinned-green',
    );
    assert(pinnedAppearance.green > 80);
    assert.equal(pinnedAppearance.purple, 0);
    const appearance = structuredClone(saved);
    appearance.nodes.find(
      (n) => n.id === f.installation.targets[0].node_id,
    )!.representation_id = f.nextAsset.representation.id;
    const attemptedAppearance = await f.api.response(
      'PUT',
      `/api/v1/lab/labs/${f.lab.id}/layout`,
      layoutInput(appearance),
    );
    expect([200, 409]).toContain(attemptedAppearance.status);
    const appearanceRejected = attemptedAppearance.status === 409;
    const appearanceResult = await attemptedAppearance.json();
    if (appearanceRejected) {
      assert.equal(appearanceResult.error?.code, 'lab.session_in_use');
      assert.deepEqual((await world(f.api, f.lab.id)).nodes, saved.nodes);
    } else saved = await world(f.api, f.lab.id);
    assertSessionGeometry(
      await pose(f.second, paused.id, boundary),
      paused,
      boundary,
    );
    expect(await maskedCanvas(f.second)).toBe(frozenImage);

    phase = 'resume-new-anchor';
    const welcomeCounts = [
      wireA.get(paused.id)!.welcomeCount,
      wireB.get(paused.id)!.welcomeCount,
    ];
    wireA.armResume(paused.id, boundary);
    wireB.armResume(paused.id, boundary);
    await action(page, f.lab.id, paused.id, 'Resume');
    await authority(f.api, f.lab.id, paused.id, 'running');
    const firstResumed = await Promise.all([
      wireA.resumedBoundary(paused.id),
      wireB.resumedBoundary(paused.id),
    ]);
    for (const frame of firstResumed) {
      assertSessionFrame(running, frame);
      const delta = BigInt(frame.sim_time_ns) - BigInt(boundary.sim_time_ns);
      assert(delta >= 0n && delta <= 250_000_000n);
    }
    const resumed = await eventually(
      () => pose(page, paused.id),
      (value) =>
        BigInt(value.nodes[0].sequence) > BigInt(boundary.sequence) &&
        BigInt(value.nodes[0].sim_time_ns) > BigInt(boundary.sim_time_ns),
    );
    assertSessionGeometry(resumed, running);
    assert.deepEqual(
      [wireA.get(paused.id)!.welcomeCount, wireB.get(paused.id)!.welcomeCount],
      welcomeCounts,
    );
    receipt('session-resume-first-received-boundary', {
      boundary,
      firstResumed,
      welcomeCounts,
    });

    phase = 'reset-original-snapshot';
    const reset = await action(page, f.lab.id, running.id, 'Reset');
    expect(reset.id).not.toBe(running.id);
    assert.equal(reset.snapshot.hash, running.snapshot.hash);
    assert.deepEqual(reset.snapshot, running.snapshot);
    const resetRunning = await authority(f.api, f.lab.id, reset.id, 'running');
    assert.notEqual(resetRunning.epoch, running.epoch);
    const resetPose = await pose(page, reset.id);
    assertSessionGeometry(resetPose, resetRunning);
    expect(
      Number(BigInt(wireA.get(reset.id)!.first!.sim_time_ns)) / 1e9,
    ).toBeLessThan(3);
    assert.deepEqual((await world(f.api, f.lab.id)).nodes, saved.nodes);
    receipt('session-reset-versus-saved', {
      oldId: running.id,
      newId: reset.id,
      originalSnapshotHash: running.snapshot.hash,
      successorSnapshotHash: reset.snapshot.hash,
      sourceTimeNs: resetPose.nodes[0].sim_time_ns,
      appearanceRejectedUntilStop: appearanceRejected,
      savedPlacementPreserved: true,
    });
    const oldAdmission = await f.api.response(
      'POST',
      `${sessionPath(f.lab.id, running.id)}/viewer-tickets`,
      { preferred_rate_hz: 30 },
    );
    expect(oldAdmission.status).toBe(409);
    await oldAdmission.arrayBuffer();

    phase = 'stop-and-next-start';
    await action(page, f.lab.id, reset.id, 'Stop');
    await authority(f.api, f.lab.id, reset.id, 'stopped');
    if (appearanceRejected) {
      const latest = await world(f.api, f.lab.id);
      latest.nodes.find(
        (n) => n.id === f.installation.targets[0].node_id,
      )!.representation_id = f.nextAsset.representation.id;
      saved = await savedLayout(f.api, f.lab.id, latest);
    }
    await expect
      .poll(
        async () =>
          (await appearancePixels(f.second, 'session-stopped-purple')).purple,
      )
      .toBeGreaterThan(80);
    const next = await f.api.json<SimulationSession>(
      'POST',
      sessionsPath(f.lab.id),
      {
        installation_id: f.installation.id,
        parameters: {
          translation_amplitude: 0.3,
          angular_speed: 0.7,
          joint_amplitude: 0.4,
        },
      },
      201,
    );
    const nextRunning = await authority(f.api, f.lab.id, next.id, 'running');
    assert.notEqual(next.snapshot.hash, running.snapshot.hash);
    assert.deepEqual(next.snapshot.world.nodes, saved.nodes);
    assert.equal(
      next.snapshot.world.nodes.find(
        (n) => n.id === f.installation.targets[0].node_id,
      )!.representation_id,
      f.nextAsset.representation.id,
    );
    assert.deepEqual(next.snapshot.parameters, {
      translation_amplitude: 0.3,
      angular_speed: 0.7,
      joint_amplitude: 0.4,
    });
    assertSessionGeometry(await pose(page, next.id), nextRunning);
    assertSessionFrame(nextRunning, wireA.get(next.id)!.latest!);
    await expect
      .poll(
        async () =>
          (await appearancePixels(f.second, 'session-next-start-purple'))
            .purple,
      )
      .toBeGreaterThan(80);

    phase = 'owned-reopen-fail-closed';
    const oldTicket = await f.api.json<SessionMotionTicket>(
      'POST',
      `${sessionPath(f.lab.id, next.id)}/viewer-tickets`,
      { preferred_rate_hz: 30 },
      201,
    );
    const restarted = await reopenOwnedApi();
    const interrupted = await authority(
      f.api,
      f.lab.id,
      next.id,
      'interrupted',
    );
    assert.equal(interrupted.snapshot.hash, next.snapshot.hash);
    const recoveredList = await f.api.json<{ active_session_id: null }>(
      'GET',
      sessionsPath(f.lab.id),
    );
    assert.equal(recoveredList.active_session_id, null);
    const stale = new SessionRawViewer(nextRunning, oldTicket);
    sockets.push(stale);
    await eventually(
      async () => stale.errors,
      (value) => value.includes('unauthorized'),
    );
    assert.deepEqual(stale.errors, ['unauthorized']);
    await eventually(
      async () => stale.socket.readyState,
      (value) => value === WebSocket.CLOSED,
      5000,
    );
    assert.equal(stale.welcome, undefined);
    assert.deepEqual((await world(f.api, f.lab.id)).nodes, saved.nodes);
    assert.deepEqual(
      (await world(f.api, f.lab.id)).relationships,
      f.before.relationships,
    );
    for (const viewer of [page, f.second]) {
      await lifecycle(viewer, 'interrupted');
      const terminal = await dialog(viewer);
      await expect(
        terminal.getByRole('button', {
          name: /^(离开观察|观察会话)$/,
        }),
      ).toBeDisabled();
      await terminal.getByRole('button', { name: '关闭', exact: true }).click();
      const terminalPose = await displayed(viewer);
      if (terminalPose) assertSessionGeometry(terminalPose, nextRunning);
      const stillAt = performance.now();
      await eventually(
        async () => {
          const current = await displayed(viewer);
          assert.deepEqual(current?.nodes ?? null, terminalPose?.nodes ?? null);
          return performance.now() - stillAt;
        },
        (elapsed) => elapsed >= 1000,
        5000,
      );
      receipt(
        viewer === page
          ? 'session-interrupted-renderer-a'
          : 'session-interrupted-renderer-b',
        {
          retainedFrozenPose: !!terminalPose,
          nodes: terminalPose?.nodes ?? null,
          elapsedMs: performance.now() - stillAt,
        },
      );
    }
    expect(errors).toEqual([]);
    assert.deepEqual(wireA.get(running.id)!.errors, []);
    assert.deepEqual(wireB.get(running.id)!.errors, []);
    receipt('session-complete-journey', {
      ids: [running.id, reset.id, next.id],
      sourceObjects: 20,
      viewers: 2,
      firstChecks,
      movement,
      pauseBoundary: boundary,
      exposed,
      restoredAfterReopen: restarted,
      latestSavedWorldPreserved: true,
      pageErrors: errors,
      scope: 'development-synthetic only',
    });
    stage('session-journey-pass');
  } catch (error) {
    stage('session-journey-error', {
      phase,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      closeSessionSockets(),
      ...contexts.map((context) => context.close()),
    ]);
    const failures = cleanup.filter((value) => value.status === 'rejected');
    cleanupFailures = failures.map(
      (value) => value.status === 'rejected' && value.reason,
    );
    stage('session-journey-owned-consumers-closed', {
      rawReaders: sockets.length,
      contexts: contexts.length,
      cleanupFailures: failures.map(
        (value) =>
          value.status === 'rejected' &&
          (value.reason instanceof Error ? value.reason.name : 'CleanupError'),
      ),
    });
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      cleanupFailures,
      'Session owned-consumer cleanup failed',
    );
});
