import { serve } from '../../apps/server/src/runtime.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { worldRoutes } from '../../packages/server/src/lab/world/routes.ts';
import { DeviceRuntime } from '../../packages/server/src/lab/devices/runtime.ts';
import { DeviceService } from '../../packages/server/src/lab/devices/use-cases.ts';
import { deviceRoutes } from '../../packages/server/src/lab/devices/routes.ts';
import { progressRoutes } from '../../packages/server/src/lab/progress/routes.ts';
import { ProgressService } from '../../packages/server/src/lab/progress/use-cases.ts';
import type {
  LabEntity,
  PersistentLab,
  DeviceCommand,
  DeviceProgramRun,
  DeviceTask,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from './server-process.ts';
import { CoreHttp } from './core-http.ts';
/** Internal supplements use real HTTP for business setup and the production runtime capability. */
export async function deviceHttpFixture() {
  const target = await new ServerProcess().create(),
    db = new Database();
  let now = '2026-10-10T12:00:00.000Z',
    server: ReturnType<typeof serve> | undefined;
  const context = { db, clock: { now: () => now } },
    policy = {
      origin: target.url,
      absoluteSecs: 604800,
      idleSecs: 86400,
      secureCookie: false,
    },
    initialRuntime = new DeviceRuntime(context, (event) =>
      console.log(JSON.stringify(event)),
    );
  let runtime = initialRuntime;
  async function close() {
    await target.cleanup();
    await runtime.stop();
    await db.close();
  }
  try {
    await db.initialize();
    await runtime.initialize();
    function appForRuntime() {
      const app = coreApp(context, '0.1.0', policy, () => {});
      worldRoutes(app, new WorldService(context, policy), () => runtime.ready);
      deviceRoutes(app, new DeviceService(context, policy, runtime));
      progressRoutes(app, new ProgressService(context, policy));
      return app;
    }
    await target.startInProcess(
      'controlled-device-http',
      async () => {
        server = serve({
          fetch: appForRuntime().fetch,
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
    // This fixture deliberately closes/reopens the same listener. Avoid
    // carrying an undici keepalive socket across that controlled boundary.
    const transport = { connection: 'close' };
    await new CoreHttp(target.url, transport).register('owner@example.test');
    const client = new CoreHttp(target.url, transport);
    await client.register('member@example.test');
    const lab = await client.json<PersistentLab>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Controlled production device' },
      201,
    );
    const path = (entity: string) =>
      '/api/v1/lab/labs/' + lab.id + '/entities/' + entity;
    return {
      db,
      get runtime() {
        return runtime;
      },
      restart: async () => {
        await runtime.stop();
        if (server)
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        const oldListening = server?.listening ?? false;
        runtime = new DeviceRuntime(context, (event) =>
          console.log(JSON.stringify(event)),
        );
        await runtime.initialize();
        await new Promise<void>((resolve) => {
          server = serve(
            {
              fetch: appForRuntime().fetch,
              port: target.port,
              hostname: '127.0.0.1',
            },
            () => resolve(),
          );
        });
        const live = await client.response('GET', '/health/live');
        if (!live.ok || oldListening || !server?.listening)
          throw new Error('Controlled restart listener did not become ready');
        await live.arrayBuffer();
        console.log(
          JSON.stringify({
            event: 'fixture.device_restarted',
            oldListening,
            newListening: server.listening,
            freshConnection: true,
            liveStatus: live.status,
            generation: runtime.generation,
          }),
        );
      },
      client,
      lab,
      target,
      context,
      policy,
      close,
      path,
      setTime: (value: string) => {
        now = value;
      },
      register: (definition: string) =>
        client.json<LabEntity>(
          'POST',
          '/api/v1/lab/labs/' + lab.id + '/entities',
          {
            name: definition,
            definition_id: definition,
            definition_version: '1.0',
            reality: 'simulated',
            configuration: {},
            representation_id: null,
          },
          201,
        ),
      start: (entity: string) =>
        client.json<DeviceProgramRun>(
          'POST',
          path(entity) + '/program/start',
          undefined,
          201,
        ),
      action: (
        entity: string,
        capability: string,
        parameters: unknown,
        key: string,
      ) =>
        client.json<DeviceCommand>(
          'POST',
          path(entity) + '/actions',
          { capability, parameters },
          202,
          { 'idempotency-key': key },
        ),
      entity: (entity: string) => client.json<LabEntity>('GET', path(entity)),
      command: (entity: string, id: string) =>
        client.json<DeviceCommand>('GET', path(entity) + '/commands/' + id),
      task: (entity: string, id: string) =>
        client.json<DeviceTask>('GET', path(entity) + '/tasks/' + id),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
