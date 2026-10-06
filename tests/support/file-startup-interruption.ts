// Necessary lifecycle barrier at the public LocalBlobStore preparation boundary.
import { run, version } from '../../apps/server/src/runtime.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
const config = configuration();
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
process.on('message', (message) => {
  if (message === 'continue-preparation') release();
});
process.on('SIGTERM', () => process.send?.({ stage: 'interruption-observed' }));
await run(async (context) => {
  const files = new FileService(
    context,
    config.files,
    config.auth,
    config.fileOrigin,
    config.directory,
  );
  const actualInitialize = files.blobs.initialize.bind(files.blobs);
  files.blobs.initialize = async () => {
    await actualInitialize();
    process.send?.({ stage: 'filesystem-admitted' });
    await gate;
  };
  await files.initialize();
  process.send?.({ stage: 'filesystem-drained' });
  return {
    app: coreApp(context, version, config.auth),
    stop: async () => {
      process.send?.({ stage: 'owned-stop' });
    },
  };
});
if (process.connected) process.disconnect();
