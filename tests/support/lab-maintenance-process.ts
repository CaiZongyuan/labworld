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
  fileRoutes(app, files);
  registerAssetFileOwnership(files);
  assetRoutes(app, files);
  worldRoutes(app, new WorldService(context, config.auth));
  const scheduler = fileScheduler(context, files, () => {});
  process.on('message', async (message) => {
    if (message === 'owned-maintain') {
      try {
        await scheduler.tick();
        process.send?.({ stage: 'maintenance-done' });
      } catch {
        process.send?.({ stage: 'maintenance-failed' });
      }
    }
  });
  return {
    app,
    stop: async () => {
      await scheduler.stop();
      if (process.connected) process.disconnect();
    },
  };
});
