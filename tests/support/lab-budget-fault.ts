// Owned calibration target: real routes/state, with additional submitted SELECTs
// only for the existing HTTP snapshot operation. No production debug endpoint.
import { run, version } from '../../apps/server/src/runtime.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { fileRoutes } from '../../packages/server/src/core/files/routes.ts';
import { fileScheduler } from '../../packages/server/src/core/files/scheduler.ts';
import { assetRoutes } from '../../packages/server/src/lab/assets/routes.ts';
import { registerAssetFileOwnership } from '../../packages/server/src/lab/assets/composition.ts';
import { worldRoutes } from '../../packages/server/src/lab/world/routes.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { sql } from '../../packages/server/src/platform/db/index.ts';
import { DeviceRuntime } from '../../packages/server/src/lab/devices/runtime.ts';
import { DeviceService } from '../../packages/server/src/lab/devices/use-cases.ts';
import { deviceRoutes } from '../../packages/server/src/lab/devices/routes.ts';
import { HistoryService } from '../../packages/server/src/lab/history/use-cases.ts';
import { RecordsService } from '../../packages/server/src/lab/records/use-cases.ts';
import { recordsRoutes } from '../../packages/server/src/lab/records/routes.ts';
import { trendRoutes } from '../../packages/server/src/lab/history/trend-routes.ts';
const config = configuration();
await run(async (context) => {
  const files = new FileService(
    context,
    config.files,
    config.auth,
    config.fileOrigin,
    config.directory,
  );
  await files.initialize();
  const app = coreApp(context, version, config.auth, undefined, config.rate);
  app.use('/api/v1/lab/labs/*', async (c, next) => {
    await next();
    if (c.req.header('x-owned-extra-sql') !== '1') return;
    await context.db.read(
      { id: c.get('requestId'), kind: 'request' },
      async (tx) => {
        for (let index = 0; index < 10; index++)
          await tx.execute(sql`select 1`);
      },
    );
  });
  fileRoutes(app, files);
  registerAssetFileOwnership(files);
  assetRoutes(app, files);
  const runtime = new DeviceRuntime(context);
  await runtime.initialize();
  worldRoutes(app, new WorldService(context, config.auth), () => runtime.ready);
  deviceRoutes(app, new DeviceService(context, config.auth, runtime));
  const history = new HistoryService(context, config.auth, config.retention);
  recordsRoutes(app, new RecordsService(history));
  trendRoutes(app, history);
  runtime.start();
  const scheduler = fileScheduler(context, files, () => {});
  return {
    app,
    stop: async () => {
      await runtime.stop();
      await scheduler.stop();
    },
  };
});
