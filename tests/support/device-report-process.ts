import { run, version } from '../../apps/server/src/runtime.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { WorldService } from '../../packages/server/src/lab/world/use-cases.ts';
import { worldRoutes } from '../../packages/server/src/lab/world/routes.ts';
import { DeviceRuntime } from '../../packages/server/src/lab/devices/runtime.ts';
import { DeviceService } from '../../packages/server/src/lab/devices/use-cases.ts';
import { deviceRoutes } from '../../packages/server/src/lab/devices/routes.ts';
const config = configuration();
await run(async (context, control) => {
  const runtime = new DeviceRuntime(context);
  await runtime.initialize();
  const app = coreApp(context, version, config.auth, () => {});
  worldRoutes(app, new WorldService(context, config.auth), () => runtime.ready);
  deviceRoutes(app, new DeviceService(context, config.auth, runtime));
  const transaction = context.db.transaction.bind(context.db);
  let release: (() => void) | undefined;
  context.db.transaction = async (operation, work) => {
    if (operation.id.startsWith('devices:report:')) {
      await new Promise<void>((resolve) => {
        release = resolve;
        process.send?.({ event: 'report-admitted' });
      });
    }
    return transaction(operation, work);
  };
  process.on(
    'message',
    (message: { operation: string; binding?: string; run?: string }) => {
      if (message.operation === 'report')
        void runtime
          .report(message.binding!, message.run!, {
            sequence: 1,
            values: { on: true },
            observed_at: context.clock.now(),
            quality: 'good',
          })
          .then((result) => process.send?.({ event: 'report-result', result }));
      if (message.operation === 'release') release?.();
      if (message.operation === 'stop')
        void control
          .stop()
          .then(() =>
            process.send?.({ event: 'closed' }, () => process.disconnect()),
          );
    },
  );
  return {
    app,
    stop: async () => {
      process.send?.({ event: 'stop-started' });
      await runtime.stop();
    },
  };
});
