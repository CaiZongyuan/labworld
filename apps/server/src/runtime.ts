import { serve } from '@hono/node-server';
export { serve };
import { readFileSync } from 'node:fs';
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
export const version = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
type Prepared = {
  app: ReturnType<typeof createApp>;
  stop?: () => Promise<void>;
};
export async function run(
  factory?: (context: FoundationContext) => Promise<Prepared>,
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
      const scheduler = fileScheduler(context, files, log);
      return { app, stop: () => scheduler.stop() };
    };
    preparing = Promise.resolve().then(() =>
      closing ? undefined : factory ? factory(context) : prepareCore(),
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
        fetch: prepared.app.fetch,
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
