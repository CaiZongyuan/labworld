// Windows SIGTERM forcibly terminates Node. Exercise the production shutdown owner through IPC.
import { run } from '../../apps/server/src/runtime.ts';

const control = await run();
if (control) {
  process.on('message', (message) => {
    if (message !== 'runtime-stop') return;
    void control.stop().then(
      () =>
        process.send?.({ event: 'runtime-stopped' }, undefined, undefined, () =>
          process.disconnect(),
        ),
      (error: unknown) => {
        process.exitCode = 1;
        process.send?.(
          { event: 'runtime-stop-failed', message: String(error) },
          undefined,
          undefined,
          () => process.disconnect(),
        );
      },
    );
  });
} else if (process.connected) process.disconnect();
