import { SimulationSessions } from '../../../packages/server/src/lab/sessions/service.ts';
import { sessionRoutes } from '../../../packages/server/src/lab/sessions/routes.ts';
import { MachineService } from '../../../packages/server/src/core/machines/use-cases.ts';
import { machineRoutes } from '../../../packages/server/src/core/machines/routes.ts';
import { SyntheticSources } from './synthetic-source.ts';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Server } from 'node:http';
import { MotionWebSockets } from './motion-ws.ts';
import { MotionFixtures } from '../../../packages/server/src/lab/motion/fixture.ts';
import { motionRoutes } from '../../../packages/server/src/lab/motion/routes.ts';
export { serve };
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { errorEnvelope } from '../../../packages/server/src/platform/http/errors.ts';
import {
  Database,
  schemaVersion,
} from '../../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../../packages/server/src/platform/db/lease.ts';
import { createApp } from '../../../packages/server/src/core/system/routes.ts';
import { coreApp } from './app.ts';
import type { FoundationContext } from '../../../packages/server/src/platform/context.ts';
import { configuration } from './config.ts';
import { FileService } from '../../../packages/server/src/core/files/use-cases.ts';
import { fileRoutes } from '../../../packages/server/src/core/files/routes.ts';
import { fileScheduler } from '../../../packages/server/src/core/files/scheduler.ts';
import { assetRoutes } from '../../../packages/server/src/lab/assets/routes.ts';
import { registerAssetFileOwnership } from '../../../packages/server/src/lab/assets/composition.ts';
import { WorldService } from '../../../packages/server/src/lab/world/use-cases.ts';
import { worldRoutes } from '../../../packages/server/src/lab/world/routes.ts';
import { ProgressService } from '../../../packages/server/src/lab/progress/use-cases.ts';
import { progressRoutes } from '../../../packages/server/src/lab/progress/routes.ts';
import { DeviceRuntime } from '../../../packages/server/src/lab/devices/runtime.ts';
import { DeviceService } from '../../../packages/server/src/lab/devices/use-cases.ts';
import { deviceRoutes } from '../../../packages/server/src/lab/devices/routes.ts';
import { WorldSubscriptions } from '../../../packages/server/src/lab/world/subscriptions.ts';
import { subscriptionRoutes } from '../../../packages/server/src/lab/world/subscription-routes.ts';
import { HistoryService } from '../../../packages/server/src/lab/history/use-cases.ts';
import { historyRoutes } from '../../../packages/server/src/lab/history/routes.ts';
import { historyScheduler } from '../../../packages/server/src/lab/history/scheduler.ts';
import { hostWeb } from './web.ts';
import { RecordsService } from '../../../packages/server/src/lab/records/use-cases.ts';
import { recordsRoutes } from '../../../packages/server/src/lab/records/routes.ts';
import { trendRoutes } from '../../../packages/server/src/lab/history/trend-routes.ts';
import { lifecycleRoutes } from '../../../packages/server/src/lab/world/lifecycle-routes.ts';
export const version = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
type Prepared = {
  app: ReturnType<typeof createApp>;
  stop?: () => Promise<void>;
  motion?: MotionWebSockets;
};
export type RuntimeControl = {
  stop: () => Promise<void>;
  ownStop: (stop: () => Promise<void>) => void;
};
export async function run(
  factory?: (
    context: FoundationContext,
    control: RuntimeControl,
  ) => Promise<Prepared>,
): Promise<RuntimeControl | undefined> {
  const config = configuration();
  const log = (entry: Record<string, unknown>) =>
    console.log(JSON.stringify(entry));
  const lease = await DirectoryLease.acquire(config.directory);
  const db = new Database(lease, (measurement) =>
    log({ event: 'database.operation', ...measurement }),
  );
  let server: ReturnType<typeof serve> | undefined;
  let stop: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let preparing: Promise<Prepared | undefined> | undefined;
  const admittedHandlers = new Set<Promise<Response>>();
  const ownedStops: Array<() => Promise<void>> = [],
    seenStops = new Set<() => Promise<void>>();
  let stoppingOwners = false;
  function ownStop(stop: () => Promise<void>) {
    if (seenStops.has(stop)) return;
    if (stoppingOwners) throw new Error('Service owner registration is closed');
    seenStops.add(stop);
    ownedStops.push(stop);
  }
  async function close() {
    if (closing) return closing;
    const admittedPreparation = preparing;
    closing = (async () => {
      const errors: unknown[] = [];
      const stopping = Promise.resolve().then(async () => {
        const prepared = await admittedPreparation?.catch(() => undefined);
        if (prepared) stop ??= prepared.stop;
        if (stop) ownStop(stop);
        stoppingOwners = true;
        const settled = await Promise.allSettled(
          ownedStops
            .reverse()
            .map((closeOwner) => Promise.resolve().then(closeOwner)),
        );
        for (const result of settled)
          if (result.status === 'rejected') errors.push(result.reason);
      });
      stopping.catch((error) => {
        errors.push(error);
      });
      try {
        if (server) {
          if ('closeIdleConnections' in server) server.closeIdleConnections();
          const deadline = setTimeout(() => {
            if (server && 'closeAllConnections' in server)
              server.closeAllConnections();
          }, 4000);
          try {
            await new Promise<void>((resolve) =>
              server!.close(() => resolve()),
            );
          } finally {
            clearTimeout(deadline);
          }
        }
      } catch (error) {
        errors.push(error);
      } finally {
        await stopping.catch(() => {});
        // A closed socket does not cancel an admitted validator or its later
        // publication. Keep the database and lease until that work settles.
        await Promise.allSettled([...admittedHandlers]);
        try {
          await db.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await lease.release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          'Shutdown failed: ' +
            errors
              .map((error) =>
                error instanceof Error ? error.message : String(error),
              )
              .join('; '),
        );
    })();
    return closing;
  }
  lease.onLost(() => {
    db.loseLease();
    void close()
      .catch((error) =>
        log({ event: 'server.close_failed', message: error.message }),
      )
      .finally(() => {
        process.exitCode = 1;
      });
  });
  const signals = ['SIGTERM', 'SIGINT'] as const;
  for (const signal of signals)
    process.once(signal, () => {
      void close().catch((error) => {
        log({ event: 'server.close_failed', message: error.message });
        process.exitCode = 1;
      });
    });
  try {
    await db.initialize();
    if (closing) {
      await closing;
      return;
    }
    const context = { db, clock: { now: () => new Date().toISOString() } };
    const prepareCore = async () => {
      const files = new FileService(
        context,
        config.files,
        config.auth,
        config.fileOrigin,
        config.directory,
      );
      await files.initialize();
      if (closing) return undefined;
      const app = coreApp(context, version, config.auth, log, config.rate);
      fileRoutes(app, files);
      registerAssetFileOwnership(files);
      assetRoutes(app, files);
      const devices = new DeviceRuntime(context, log);
      ownStop(() => devices.stop());
      await devices.initialize();
      const world = new WorldService(context, config.auth);
      worldRoutes(app, world, () => devices.ready);
      const fixtures = new MotionFixtures(world, config.motionFixture);
      motionRoutes(app, fixtures, (c) => getConnInfo(c).remote.address);
      const sessions = new SimulationSessions(
        world,
        {
          enabled: config.syntheticSession,
          graceMillis: config.motionGraceMillis,
          ackMillis: config.motionAckMillis,
        },
        log,
      );
      ownStop(() => sessions.stop());
      await sessions.initialize();
      sessionRoutes(app, sessions, (c) => getConnInfo(c).remote.address);
      machineRoutes(
        app,
        new MachineService(context, config.auth, 'lab:full', (id) =>
          sessions.machineRevoked(id),
        ),
      );
      const motion =
        config.motionFixture || config.syntheticSession
          ? new MotionWebSockets(fixtures, config.auth.origin, sessions, log)
          : undefined;
      const sources = new SyntheticSources(
        {
          directory: config.directory,
          python: config.syntheticPython,
          publisher: config.syntheticPublisher,
          url: `http://${config.hostname === '::1' ? '[::1]' : config.hostname}:${config.port}`,
          port: config.port,
        },
        (id) => sessions.sourceExited(id),
        log,
      );
      ownStop(() => sources.stop());
      await sources.initialize(config.syntheticSession);
      if (config.syntheticSession && motion)
        sessions.configure(
          (input) => sources.launch(input),
          (id) => motion.fence(id),
        );
      if (motion) ownStop(() => motion.stop());
      progressRoutes(app, new ProgressService(context, config.auth));
      lifecycleRoutes(app, world);
      const subscriptions = new WorldSubscriptions(world, () => devices.ready);
      ownStop(() => subscriptions.stop());
      subscriptionRoutes(app, subscriptions);
      deviceRoutes(app, new DeviceService(context, config.auth, devices));
      const history = new HistoryService(
        context,
        config.auth,
        config.retention,
      );
      historyRoutes(app, history);
      recordsRoutes(app, new RecordsService(history));
      trendRoutes(app, history);
      const maintenance = historyScheduler(history, log);
      ownStop(() => maintenance.stop());
      const scheduler = fileScheduler(context, files, log);
      ownStop(() => scheduler.stop());
      devices.start();
      subscriptions.start();
      if (config.webDirectory) await hostWeb(app, config.webDirectory);
      return {
        app,
        motion,
      };
    };
    preparing = Promise.resolve().then(() =>
      closing
        ? undefined
        : factory
          ? factory(context, { stop: close, ownStop })
          : prepareCore(),
    );
    const prepared = await preparing;
    preparing = undefined;
    if (prepared) stop = prepared.stop;
    if (closing) {
      await closing;
      return;
    }
    if (!prepared) throw new Error('Server preparation was cancelled');
    server = serve(
      {
        fetch: async (request, ...args) => {
          if (closing) {
            const id = randomUUID();
            return Response.json(
              errorEnvelope(
                'system.unavailable',
                'Server is shutting down',
                id,
              ),
              {
                status: 503,
                headers: { 'x-request-id': id, 'cache-control': 'no-store' },
              },
            );
          }
          const handling = Promise.resolve(
            prepared.app.fetch(request, ...args),
          );
          admittedHandlers.add(handling);
          try {
            return await handling;
          } finally {
            admittedHandlers.delete(handling);
          }
        },
        hostname: config.hostname,
        port: config.port,
      },
      () =>
        log({
          event: 'server.ready',
          host: config.hostname,
          port: config.port,
          version,
          schema_version: schemaVersion,
        }),
    );
    prepared.motion?.attach(server as Server);
    server.on('error', (error) => {
      log({ event: 'server.start_failed', message: error.message });
      void close()
        .catch((error) =>
          log({ event: 'server.close_failed', message: error.message }),
        )
        .finally(() => {
          process.exitCode = 1;
        });
    });
    return { stop: close, ownStop };
  } catch (error) {
    log({
      event: 'server.start_failed',
      message: error instanceof Error ? error.message : 'Startup failed',
    });
    try {
      await close();
    } catch (cleanup) {
      log({
        event: 'server.close_failed',
        message: cleanup instanceof Error ? cleanup.message : 'Cleanup failed',
      });
    }
    process.exitCode = 1;
  }
}
