import { serve } from '../../apps/server/src/runtime.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { motionTransportAllowed } from '../../apps/server/src/transport.ts';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { worldRoutes } from '../../packages/server/src/lab/world/routes.ts';
import { SourceService } from '../../packages/server/src/lab/sources/service.ts';
import { sourceRoutes } from '../../packages/server/src/lab/sources/routes.ts';
import { ServerProcess } from './server-process.ts';
import { CoreHttp } from './core-http.ts';

/** A controlled clock drives public credential expiry and presence deadlines through real HTTP. */
export async function sourceHttpFixture() {
  const target = await new ServerProcess().create();
  const db = new Database();
  let now = new Date().toISOString();
  const policy = {
    origin: target.url,
    absoluteSecs: 604800,
    idleSecs: 86400,
    secureCookie: false,
  };
  const sources = new SourceService(
    new WorldService({ db, clock: { now: () => now } }, policy),
    target.url,
  );
  let server: ReturnType<typeof serve> | undefined;
  const close = async () => {
    await target.cleanup();
    await db.close();
  };
  try {
    await db.initialize();
    await sources.initialize();
    const app = coreApp(sources.world.context, '0.1.0', policy, () => {});
    worldRoutes(app, sources.world);
    sourceRoutes(app, sources, (c) => motionTransportAllowed(c.env?.incoming));
    await target.startInProcess(
      'source-presence-http',
      async () => {
        server = serve({
          fetch: app.fetch,
          port: target.port,
          hostname: '127.0.0.1',
        });
      },
      async () => {
        await sources.stop();
        if (server)
          await new Promise<void>((resolve) => server!.close(() => resolve()));
      },
    );
    const member = new CoreHttp(target.url);
    await member.register('controlled-source@example.test');
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Controlled source clock' },
      201,
    );
    return {
      target,
      member,
      lab,
      close,
      advance: (millis: number) => {
        now = new Date(Date.parse(now) + millis).toISOString();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
