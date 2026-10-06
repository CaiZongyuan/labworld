import { registerHooks } from 'node:module';
const facade = new URL('./lab-validation-barrier-codecs.ts', import.meta.url)
  .href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith('/platform/codecs.ts') &&
      context.parentURL?.endsWith('/lab/assets/validation.ts')
    )
      return { url: facade, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { run, version } = await import('../../apps/server/src/runtime.ts');
const { configuration } = await import('../../apps/server/src/config.ts');
const { coreApp } = await import('../../apps/server/src/app.ts');
const { FileService } =
  await import('../../packages/server/src/core/files/use-cases.ts');
const { fileRoutes } =
  await import('../../packages/server/src/core/files/routes.ts');
const { fileScheduler } =
  await import('../../packages/server/src/core/files/scheduler.ts');
const { assetRoutes } =
  await import('../../packages/server/src/lab/assets/routes.ts');
const { registerAssetFileOwnership } =
  await import('../../packages/server/src/lab/assets/composition.ts');
const config = configuration();
await run(async (context, lifecycle) => {
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
  const scheduler = fileScheduler(context, files, () => {});
  process.on('message', (message) => {
    if (message === 'owned-stop')
      void lifecycle
        .stop()
        .then(() => process.send?.({ stage: 'runtime-drained' }));
    if (message === 'owned-release') process.emit('owned-release-validator');
    if (message === 'owned-exit' && process.connected) process.disconnect();
  });
  return { app, stop: () => scheduler.stop() };
});
