import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  assertTrajectory,
  assertAdvanced,
  displayed,
  expectedBody,
  type Diagnostic,
} from './motion-oracle';
import {
  Actors,
  prepare,
  joinViewer,
  leaveViewer,
  ready,
  pixels,
  metrics,
  ticket,
  wireObserver,
  rawAdmission,
  unmaskedError,
  eventually,
  observer,
  receipt,
  stage,
} from './motion-support';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });

test('motion smoke: real Python, same-port authenticated Node, two GLB viewers, raw guards and renderer oracle', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  stage('smoke-start', { product: process.env.MOTION_E2E_PRODUCT_COMMIT });
  const actors = await Actors.create('motion-smoke');
  let context;
  try {
    const world = await prepare(page, browser);
    context = world.secondContext;
    const wireA = wireObserver(page),
      wireB = wireObserver(world.second);
    const denied = await rawAdmission(
      world.fixture,
      {
        ticket: 'invalid_ticket_value',
        websocket_path: `/api/v1/lab/motion/sessions/${world.fixture.session_id}/viewer`,
      },
      'viewer',
    );
    expect(
      denied.messages.every(
        (entry) =>
          !entry.binary &&
          JSON.parse(entry.data.toString()).type === 'motion.error',
      ),
    ).toBe(true);
    await eventually(
      async () => denied.ws.readyState,
      (value) => value === WebSocket.CLOSED,
    );
    const savedCsrf = world.api.csrf;
    world.api.csrf = undefined;
    await world.api.error(
      'POST',
      `/api/v1/lab/labs/${world.fixture.lab_id}/motion-fixture/${world.fixture.session_id}/viewer-tickets`,
      { preferred_rate_hz: 30 },
      403,
      'auth.csrf',
    );
    world.api.csrf = savedCsrf;
    await joinViewer(page, 30);
    await joinViewer(world.second, 30);
    const source = actors.publisher(
      world.fixture,
      await ticket(world.api, world.fixture, 'publisher'),
      120,
    );
    const a = await ready(page),
      b = await ready(world.second);
    const oracleA = assertTrajectory(a, world.fixture.session_id),
      oracleB = assertTrajectory(b, world.fixture.session_id);
    expect(a.epoch).toBe(b.epoch);
    const advancedA = (await eventually(
      () => displayed(page),
      (value) =>
        value !== null &&
        BigInt(value.nodes[0].sim_time_ns) >=
          BigInt(a.nodes[0].sim_time_ns) + 1_000_000_000n,
    )) as Diagnostic;
    const advancedB = (await eventually(
      () => displayed(world.second),
      (value) =>
        value !== null &&
        BigInt(value.nodes[0].sim_time_ns) >=
          BigInt(b.nodes[0].sim_time_ns) + 1_000_000_000n,
    )) as Diagnostic;
    const movement = [
      assertAdvanced(a, advancedA, 1_000_000_000n),
      assertAdvanced(b, advancedB, 1_000_000_000n),
    ];
    assertTrajectory(advancedA, world.fixture.session_id);
    assertTrajectory(advancedB, world.fixture.session_id);
    const geometry = [];
    for (const viewer of [page, world.second]) {
      const sample = await eventually(
        () => metrics(viewer),
        (value) => Number(value.stats['三角形']?.replaceAll(',', '')) >= 240,
      );
      // The tracked cube has twelve triangles; twenty rendered copies need 240.
      expect(
        Number(sample.stats['三角形']?.replaceAll(',', '')),
      ).toBeGreaterThanOrEqual(240);
      geometry.push(sample);
    }
    const exposures = [
      await pixels(page, 'smoke-viewer-a'),
      await pixels(world.second, 'smoke-viewer-b'),
    ];
    await eventually(
      async () => wireA.frames + wireB.frames,
      (value) => value >= 30,
    );
    expect(wireA.errors).toEqual([]);
    expect(wireB.errors).toEqual([]);
    expect(
      await world.api.json(
        'GET',
        `/api/v1/lab/labs/${world.fixture.lab_id}/world`,
      ),
    ).toEqual(world.before);
    await unmaskedError(world.fixture);
    await eventually(
      async () => observer().liveSockets,
      (value) => value === 3,
      5000,
    );
    await actors.stop(source);
    await expect(page.getByRole('button', { name: /^合成运动/ })).toContainText(
      '运动中断',
    );
    await expect(
      world.second.getByRole('button', { name: /^合成运动/ }),
    ).toContainText('运动中断');
    await leaveViewer(page);
    await leaveViewer(world.second);
    await eventually(
      async () => observer().liveSockets,
      (value) => value === 0,
    );
    const observed = observer();
    expect(observed.directPoseDbCalls).toBe(0);
    expect(observed.pendingMaxSlots).toBe(1);
    expect(observed.pendingMaxBytes).toBe(632);
    receipt('smoke', {
      oracleA,
      oracleB,
      movement,
      geometry,
      exposures,
      wireA,
      wireB,
      observed,
      source: { stdout: source.stdout, stderr: source.stderr },
      topology: { http: process.env.E2E_API_URL, web: process.env.E2E_WEB_URL },
      scenarios: [
        'invalid-ticket-no-data',
        'csrf-denial',
        'real-python-two-viewers',
        'raw-wire-source-formula',
        'actual-world-transforms',
        'exterior-model-pixels',
        'unmasked-ws-error-cleanup',
        'interrupted',
        'leave-cleanup',
        'saved-world-unchanged',
      ],
    });
    stage('smoke-pass');
  } finally {
    await context?.close();
    await actors.cleanup();
    stage('smoke-actors-cleaned');
  }
});

test('motion full: 600 seconds common-ready source, rate isolation, late join, real TCP pressure and lifecycle', async ({
  page,
  browser,
}) => {
  test.setTimeout(900000);
  stage('full-start', {
    product: process.env.MOTION_E2E_PRODUCT_COMMIT,
    requiredCommonReadySeconds: 600,
  });
  const actors = await Actors.create('motion-full');
  const samples: Record<string, unknown>[] = [];
  const contexts = [];
  const errors: string[] = [];
  try {
    const world = await prepare(page, browser);
    contexts.push(world.secondContext);
    for (const viewer of [page, world.second])
      viewer.on('pageerror', (error) => errors.push(error.name));
    const wireA = wireObserver(page),
      wireB = wireObserver(world.second);
    await joinViewer(page, 30);
    await joinViewer(world.second, 15);
    const source = actors.publisher(
      world.fixture,
      await ticket(world.api, world.fixture, 'publisher'),
      660,
    );
    await ready(page);
    await ready(world.second);
    const ratesAt = performance.now(),
      counts = [wireA.frames, wireB.frames];
    await new Promise((done) => setTimeout(done, 10000));
    const rateSeconds = (performance.now() - ratesAt) / 1000;
    const rates = [
      (wireA.frames - counts[0]) / rateSeconds,
      (wireB.frames - counts[1]) / rateSeconds,
    ];
    expect(rates[0]).toBeGreaterThan(20);
    expect(rates[0]).toBeLessThanOrEqual(30.5);
    expect(rates[1]).toBeGreaterThan(10);
    expect(rates[1]).toBeLessThanOrEqual(15.5);
    expect(rates[0] / rates[1]).toBeGreaterThan(1.5);
    expect(rates[0] / rates[1]).toBeLessThanOrEqual(2.5);
    receipt('rates', {
      requested: [30, 15],
      actualReceiveHz: rates,
      seconds: rateSeconds,
      boundary:
        'actual browser WebSocket received binary snapshots, independent of rendering FPS; service-controlled ceilings',
    });
    const lateContext = await browser.newContext({
      storageState: await page.context().storageState(),
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(lateContext);
    const late = await lateContext.newPage();
    await late.goto(`/lab?lab=${world.fixture.lab_id}`);
    await expect(late.locator('.world-page')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await joinViewer(late, 30);
    const latePose = await ready(late);
    assertTrajectory(latePose, world.fixture.session_id);
    expect(BigInt(latePose.nodes[0].sim_time_ns)).toBeGreaterThan(
      8_000_000_000n,
    );
    await pixels(late, 'late-join');
    receipt('late-join', {
      epoch: latePose.epoch,
      sourceTimeNs: latePose.nodes[0].sim_time_ns,
      nodes: latePose.nodes.length,
    });
    await lateContext.close();
    await leaveViewer(world.second);
    await joinViewer(world.second, 30);
    await ready(world.second);
    const slowId = Math.max(...observer().sockets.map((entry) => entry.id));
    const slowTicket = await ticket(world.api, world.fixture, 'viewer');
    const slow = actors.start(
      process.env.MOTION_E2E_SLOW_READER!,
      [
        process.env.E2E_API_URL!.replace('http:', 'ws:') +
          slowTicket.websocket_path,
        process.env.E2E_WEB_URL!,
        world.fixture.session_id,
      ],
      slowTicket.ticket,
    );
    await eventually(
      async () => slow.stdout,
      (value) => value.includes('slow.pressure'),
    );
    expect(slow.stdout).toContain('"transport_reading": false');
    const start = performance.now(),
      startStats = observer(),
      startCounts = [wireA.frames, wireB.frames];
    stage('common-ready-start', {
      viewerRateHz: [30, 30],
      bodyCount: 20,
      jointCount: 6,
      sourceHz: 30,
    });
    let pressure;
    let previous: [Diagnostic, Diagnostic] | null = null;
    while (performance.now() - start < 600000) {
      expect(source.child.exitCode).toBeNull();
      expect(errors).toEqual([]);
      const a = await ready(page),
        b = await ready(world.second);
      const checks = [
        assertTrajectory(a, world.fixture.session_id),
        assertTrajectory(b, world.fixture.session_id),
      ];
      expect(a.epoch).toBe(b.epoch);
      if (previous) {
        assertAdvanced(previous[0], a);
        assertAdvanced(previous[1], b);
      }
      previous = [a, b];
      for (const viewer of [page, world.second])
        await expect(
          viewer.getByRole('button', { name: /^合成运动/ }),
        ).toContainText('运动已连接');
      expect(wireA.errors).toEqual([]);
      expect(wireB.errors).toEqual([]);
      const observed = observer();
      expect(observed.directPoseDbCalls).toBe(0);
      expect(observed.pendingMaxSlots).toBeLessThanOrEqual(1);
      expect(observed.pendingMaxBytes).toBeLessThanOrEqual(632);
      pressure = observed.sockets.find(
        (entry) => entry.id > slowId && entry.role === 'viewer',
      );
      samples.push({
        elapsedMs: performance.now() - start,
        checks,
        sequence: [a.nodes[0].sequence, b.nodes[0].sequence],
        timeNs: [a.nodes[0].sim_time_ns, b.nodes[0].sim_time_ns],
        render: [await metrics(page), await metrics(world.second)],
        rssBytes: observed.rssBytes,
        receiveFrames: [wireA.frames, wireB.frames],
        slow: pressure,
      });
      if (samples.length % 12 === 0) {
        receipt('full-progress', {
          samples,
          elapsedSeconds: (performance.now() - start) / 1000,
        });
        stage('common-ready-progress', {
          elapsedSeconds: Math.round((performance.now() - start) / 1000),
          slowClosed: pressure?.open === false,
        });
      }
      await new Promise((done) => setTimeout(done, 5000));
    }
    const elapsedSeconds = (performance.now() - start) / 1000;
    const finalStats = observer();
    const sourceHz = (finalStats.frames - startStats.frames) / elapsedSeconds;
    expect(elapsedSeconds).toBeGreaterThanOrEqual(600);
    expect(sourceHz).toBeGreaterThanOrEqual(29);
    expect(sourceHz).toBeLessThanOrEqual(30.5);
    expect(pressure?.open).toBe(false);
    expect(pressure?.closeReason).toBe('slow_viewer');
    expect(pressure?.maxBufferBytes ?? 0).toBeGreaterThan(64 * 1024);
    const exposures = [
      await pixels(page, 'full-viewer-a'),
      await pixels(world.second, 'full-viewer-b'),
    ];
    expect(
      await world.api.json(
        'GET',
        `/api/v1/lab/labs/${world.fixture.lab_id}/world`,
      ),
    ).toEqual(world.before);
    receipt('full-baseline', {
      elapsedSeconds,
      sourceHz,
      bodyCount: 20,
      jointCount: 6,
      sourceSampleHz: 30,
      viewers: 2,
      startCounts,
      endCounts: [wireA.frames, wireB.frames],
      slowPressure: pressure,
      slowEvidence: slow.stdout,
      exposures,
      samples,
      observed: finalStats,
      errors,
      sourceBuild: process.env.MOTION_E2E_PRODUCT_COMMIT,
    });
    stage('common-ready-pass', { elapsedSeconds, sourceHz });
    await actors.stop(slow);

    // Same-process local freshness is a separate source/connection state.
    source.child.kill('SIGSTOP');
    try {
      for (const viewer of [page, world.second])
        await expect(
          viewer.getByRole('button', { name: /^合成运动/ }),
        ).toContainText('运动过期');
      const frozen = await displayed(page);
      await new Promise((done) => setTimeout(done, 750));
      expect((await displayed(page))?.nodes).toEqual(frozen?.nodes);
      const rectangle = (await page.locator('canvas').boundingBox())!;
      for (const [viewer, name] of [
        [page, 'Synthetic body 00'],
        [world.second, 'Synthetic body 01'],
      ] as const) {
        const directory = viewer.getByRole('button', {
          name: '打开对象目录',
          exact: true,
        });
        if ((await directory.getAttribute('aria-expanded')) === 'false')
          await directory.click();
        await viewer
          .getByRole('button', { name: `选择 ${name}`, exact: true })
          .click();
        await expect(
          viewer.getByRole('complementary', { name: '对象信息' }),
        ).toContainText(name);
      }
      const otherBefore = await world.second
        .locator('canvas')
        .screenshot({ mask: [world.second.locator('.lab-perf')] });
      const firstBefore = await page
        .locator('canvas')
        .screenshot({ mask: [page.locator('.lab-perf')] });
      await page.mouse.move(
        rectangle.x + rectangle.width / 2,
        rectangle.y + rectangle.height / 2,
      );
      await page.mouse.wheel(0, -180);
      await new Promise((done) => setTimeout(done, 1000));
      expect(
        createHash('sha256')
          .update(
            await page
              .locator('canvas')
              .screenshot({ mask: [page.locator('.lab-perf')] }),
          )
          .digest('hex'),
      ).not.toBe(createHash('sha256').update(firstBefore).digest('hex'));
      expect(
        createHash('sha256')
          .update(
            await world.second
              .locator('canvas')
              .screenshot({ mask: [world.second.locator('.lab-perf')] }),
          )
          .digest('hex'),
      ).toBe(createHash('sha256').update(otherBefore).digest('hex'));
    } finally {
      source.child.kill('SIGCONT');
    }
    await expect(page.getByRole('button', { name: /^合成运动/ })).toContainText(
      '运动已连接',
    );
    await actors.stop(source);
    await expect(page.getByRole('button', { name: /^合成运动/ })).toContainText(
      '运动中断',
    );
    await guardPackets(world, page, world.second);

    const oldEpoch = BigInt((await ready(page)).epoch);
    const replacement = actors.publisher(
      world.fixture,
      await ticket(world.api, world.fixture, 'publisher'),
      90,
    );
    const replacementPose = (await eventually(
      () => displayed(page),
      (value) =>
        value !== null &&
        BigInt(value.epoch) > oldEpoch &&
        value.nodes.length === 20,
    )) as Diagnostic;
    expect(BigInt(replacementPose.epoch)).toBeGreaterThan(oldEpoch);
    expect(BigInt(replacementPose.nodes[0].sim_time_ns)).toBeLessThan(
      10_000_000_000n,
    );
    assertTrajectory(replacementPose, world.fixture.session_id);
    for (let i = 0; i < 3; i++) {
      await leaveViewer(world.second);
      await joinViewer(world.second, 30);
      assertTrajectory(await ready(world.second), world.fixture.session_id);
    }
    const loadedMetrics = await metrics(world.second);
    const empty = await world.api.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Empty motion resource Lab' },
      201,
    );
    const resources = [];
    for (let i = 0; i < 3; i++) {
      await world.second.goto(`/lab?lab=${empty.id}`);
      await expect(world.second.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect.poll(() => displayed(world.second)).toBeNull();
      await world.second
        .getByRole('button', { name: '性能', exact: true })
        .click();
      const emptyMetrics = await eventually(
        () => metrics(world.second),
        (value) =>
          Number(value.stats.Geometries) <
          Number(loadedMetrics.stats.Geometries),
      );
      resources.push({ state: 'empty', metrics: emptyMetrics });
      await world.second.goto(`/lab?lab=${world.fixture.lab_id}`);
      await expect(world.second.locator('.world-page')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await world.second
        .getByRole('button', { name: '性能', exact: true })
        .click();
      await joinViewer(world.second, 30);
      await ready(world.second);
      const nextLoadedMetrics = await eventually(
        () => metrics(world.second),
        (value) =>
          value.stats.Geometries === loadedMetrics.stats.Geometries &&
          value.stats.Textures === loadedMetrics.stats.Textures,
      );
      resources.push({ state: 'loaded', metrics: nextLoadedMetrics });
    }
    const restoredMetrics = await metrics(world.second);
    expect(restoredMetrics.stats.Geometries).toBe(
      loadedMetrics.stats.Geometries,
    );
    expect(restoredMetrics.stats.Textures).toBe(loadedMetrics.stats.Textures);
    await actors.stop(replacement);
    await leaveViewer(page);
    await leaveViewer(world.second);
    await eventually(
      async () => observer().liveSockets,
      (value) => value === 0,
    );
    receipt('lifecycle', {
      scenarios: [
        'stale-freeze',
        'independent-camera',
        'interrupted',
        'explicit-new-publisher-epoch',
        'bad-packet-trusted-pose',
        'three-join-leave',
        'three-empty-loaded-lab-switch',
      ],
      loadedMetrics,
      restoredMetrics,
      resources,
      observer: observer(),
    });
    stage('full-pass');
  } finally {
    for (const context of contexts) await context.close();
    await actors.cleanup();
    receipt('full-last-samples', samples);
    stage('full-actors-cleaned');
  }
});

async function guardPackets(
  world: Awaited<ReturnType<typeof prepare>>,
  first: Page,
  second: Page,
) {
  const results = [];
  for (const mutation of [
    'old-epoch',
    'mapping',
    'duplicate-sequence',
    'nan',
    'flags',
  ]) {
    const peer = await rawAdmission(
      world.fixture,
      await ticket(world.api, world.fixture, 'publisher'),
      'publisher',
    );
    try {
      const welcome = JSON.parse(peer.messages[0].data.toString());
      expect(welcome.type).toBe('motion.welcome');
      const valid = Buffer.alloc(632);
      valid.write('LWM1', 0, 'ascii');
      valid[4] = 1;
      valid[5] = 1;
      valid.writeBigUInt64LE(BigInt(welcome.epoch), 8);
      valid.writeBigUInt64LE(1n, 16);
      valid.writeUInt32LE(1, 32);
      valid.writeUInt32LE(20, 36);
      valid.writeUInt32LE(6, 40);
      valid.writeUInt32LE(584, 44);
      for (let i = 0; i < 20; i++)
        [
          ...expectedBody(i, '0').position,
          ...expectedBody(i, '0').quaternion,
        ].forEach((number, axis) =>
          valid.writeFloatLE(number, 48 + i * 28 + axis * 4),
        );
      for (let i = 0; i < 6; i++)
        valid.writeFloatLE(0.5 * Math.sin(i * 0.2), 608 + i * 4);
      peer.ws.send(valid);
      const trusted = (await eventually(
        () => displayed(first),
        (value) =>
          value !== null &&
          value.epoch === String(welcome.epoch) &&
          value.nodes[0].sequence === '1',
      )) as Diagnostic;
      assertTrajectory(trusted, world.fixture.session_id);
      const bad = Buffer.from(valid);
      bad.writeBigUInt64LE(2n, 16);
      bad.writeBigUInt64LE(33_333_333n, 24);
      if (mutation === 'old-epoch')
        bad.writeBigUInt64LE(BigInt(welcome.epoch) - 1n, 8);
      if (mutation === 'mapping') bad.writeUInt32LE(2, 32);
      if (mutation === 'duplicate-sequence') bad.writeBigUInt64LE(1n, 16);
      if (mutation === 'nan') bad.writeFloatLE(NaN, 48);
      if (mutation === 'flags') bad.writeUInt16LE(1, 6);
      peer.ws.send(bad);
      await eventually(
        async () => peer.ws.readyState,
        (value) => value === WebSocket.CLOSED,
      );
      expect(
        peer.messages.some(
          (message) =>
            !message.binary &&
            JSON.parse(message.data.toString()).type === 'motion.error',
        ),
      ).toBe(true);
      expect((await displayed(first))?.nodes).toEqual(trusted.nodes);
      assertTrajectory(await ready(second), world.fixture.session_id);
      results.push({ mutation, rejected: true, epoch: welcome.epoch });
    } finally {
      peer.ws.terminate();
    }
  }
  receipt('packet-guards', results);
}
