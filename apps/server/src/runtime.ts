import { serve } from '@hono/node-server';
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
export const version = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
type Prepared = {
  app: ReturnType<typeof createApp>;
  stop?: () => Promise<void>;
};
export type RuntimeControl = { stop: () => Promise<void> };
export async function run(
  factory?: (
    context: FoundationContext,
    control: RuntimeControl,
  ) => Promise<Prepared>,
) {
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
  async function close() {
    if (closing) return closing;
    const admittedPreparation = preparing;
    closing = (async () => {
      const stopping = Promise.resolve().then(async () => {
        const prepared = await admittedPreparation?.catch(() => undefined);
        if (prepared) stop ??= prepared.stop;
        await stop?.();
      });
      stopping.catch(() => {});
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
        await stopping;
      } finally {
        // A closed socket does not cancel an admitted validator or its later
        // publication. Keep the database and lease until that work settles.
        await Promise.allSettled([...admittedHandlers]);
        try {
          await db.close();
        } finally {
          await lease.release();
        }
      }
    })();
    return closing;
  }
  lease.onLost(() => {
    db.loseLease();
    void close().finally(() => {
      process.exitCode = 1;
    });
  });
  const signals = ['SIGTERM', 'SIGINT'] as const;
  for (const signal of signals)
    process.once(signal, () => {
      void close();
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
      worldRoutes(app, new WorldService(context, config.auth));
      const scheduler = fileScheduler(context, files, log);
      return { app, stop: () => scheduler.stop() };
    };
    preparing = Promise.resolve().then(() =>
      closing
        ? undefined
        : factory
          ? factory(context, { stop: close })
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
    server.on('error', () => {
      void close().finally(() => {
        process.exitCode = 1;
      });
    });
  } catch (error) {
    log({
      event: 'server.start_failed',
      message: error instanceof Error ? error.message : 'Startup failed',
    });
    await close();
    process.exitCode = 1;
  }
}
