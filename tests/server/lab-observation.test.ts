import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../../apps/server/src/runtime.ts';
import type {
  LabEntity,
  PersistentLab,
  DeviceProgramRun,
  LabWorld,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { worldRoutes } from '../../packages/server/src/lab/world/routes.ts';
import { DeviceRuntime } from '../../packages/server/src/lab/devices/runtime.ts';
import { DeviceService } from '../../packages/server/src/lab/devices/use-cases.ts';
import { deviceRoutes } from '../../packages/server/src/lab/devices/routes.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test('internal.observation: exact source watermark survives unknown time; expiry preserves fractional reception and rejected ingress leaves public World unchanged', async () => {
  const target = await new ServerProcess().create(),
    db = new Database();
  let now = '2026-10-10T12:00:00.123456789Z';
  const context = { db, clock: { now: () => now } },
    policy = {
      origin: target.url,
      absoluteSecs: 604800,
      idleSecs: 86400,
      secureCookie: false,
    },
    runtime = new DeviceRuntime(context);
  let server: ReturnType<typeof serve> | undefined;
  try {
    await db.initialize();
    await runtime.initialize();
    const app = coreApp(context, '0.1.0', policy, () => {});
    worldRoutes(app, new WorldService(context, policy), () => runtime.ready);
    deviceRoutes(app, new DeviceService(context, policy, runtime));
    await target.startInProcess(
      'trusted-observation-http',
      async () => {
        server = serve({
          fetch: app.fetch,
          port: target.port,
          hostname: '127.0.0.1',
        });
      },
      async () => {
        await runtime.stop();
        if (server)
          await new Promise<void>((resolve) => server!.close(() => resolve()));
      },
    );
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const lab = await client.json<PersistentLab>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Exact ingress' },
      201,
    );
    const entity = await client.json<LabEntity>(
      'POST',
      '/api/v1/lab/labs/' + lab.id + '/entities',
      {
        name: 'Precise light',
        definition_id: 'light',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: {},
        representation_id: null,
      },
      201,
    );
    const path = '/api/v1/lab/labs/' + lab.id + '/entities/' + entity.id;
    const run = await client.json<DeviceProgramRun>(
      'POST',
      path + '/program/start',
      undefined,
      201,
    );
    const read = () => client.json<LabEntity>('GET', path),
      world = () =>
        client.json<LabWorld>('GET', '/api/v1/lab/labs/' + lab.id + '/world');
    assert.equal(
      await runtime.report(run.binding_id, run.id, {
        sequence: 1,
        values: { on: true },
        observed_at: now,
        quality: 'good',
      }),
      'applied',
    );
    assert.equal(
      (await read()).observation!.properties.on.expires_at,
      '2026-10-10T12:00:05.123456789Z',
    );
    assert.equal(
      await runtime.report(run.binding_id, run.id, {
        sequence: 2,
        values: { on: false },
        observed_at: null,
        quality: 'good',
      }),
      'applied',
    );
    const before = await world();
    assert.equal(
      await runtime.report(run.binding_id, run.id, {
        sequence: 3,
        values: { on: true },
        observed_at: '2026-10-10T12:00:00.123456788Z',
        quality: 'good',
      }),
      'out_of_order',
    );
    assert.deepEqual(await world(), before);
    now = '2026-10-10T12:00:05.123456788Z';
    await runtime.tick();
    assert.deepEqual(await world(), before);
    now = '2026-10-10T12:00:05.123456789Z';
    await runtime.tick();
    assert.equal((await read()).observation!.properties.on.freshness, 'stale');
    assert.equal(
      await runtime.report(run.binding_id, run.id, {
        sequence: 3,
        values: { on: true },
        observed_at: now,
        quality: 'good',
      }),
      'applied',
    );
    assert.equal((await read()).observation!.properties.on.value, true);
  } finally {
    await target.cleanup();
    await runtime.stop();
    await db.close();
  }
});
