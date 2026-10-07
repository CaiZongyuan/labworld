// Necessary real-process lifecycle supplement: a real DeviceRuntime and owned TCP handle.
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import {
  run,
  version,
  type RuntimeControl,
} from '../../apps/server/src/runtime.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { DeviceRuntime } from '../../packages/server/src/lab/devices/runtime.ts';
const config = configuration(),
  mode = process.env.OWNED_LIFECYCLE_MODE;
const facts = {
  owner: 'developer_m3a issue51 lifecycle fixture',
  pid: process.pid,
  title: process.title,
  resources: [] as Array<{ name: string; port?: number; state: string }>,
};
function record() {
  writeFileSync(
    process.env.OWNED_LIFECYCLE_LEDGER!,
    JSON.stringify(facts, null, 2),
  );
}
await run(async (context, control) => {
  const own = (
    control as RuntimeControl & {
      ownStop?: (stop: () => Promise<void>) => void;
    }
  ).ownStop;
  const runtime = new DeviceRuntime(context);
  await runtime.initialize();
  runtime.start();
  facts.resources.push({ name: 'real DeviceRuntime', state: 'owned' });
  record();
  const stopRuntime = async () => {
    await runtime.stop();
    facts.resources[0].state = 'stopped';
    record();
  };
  own?.(stopRuntime);
  const socket = createServer();
  await new Promise<void>((resolve) =>
    socket.listen(mode === 'partial' ? config.port : 0, '127.0.0.1', resolve),
  );
  facts.resources.push({
    name: 'owned preparation socket',
    port: (socket.address() as { port: number }).port,
    state: 'owned',
  });
  record();
  const stopSocket = async () => {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    facts.resources[1].state = 'stopped';
    record();
    process.send?.({ event: 'owner-stopped' });
  };
  own?.(stopSocket);
  if (mode === 'partial') {
    process.send?.({ event: 'owner-admitted' });
    throw new Error('Owned later preparation failure');
  }
  const failStop = async () => {
    throw new Error('Owned first stop failure');
  };
  own?.(failStop);
  process.on('message', (message) => {
    if (message === 'owned-stop')
      void control
        .stop()
        .then(() => process.disconnect())
        .catch((error) => {
          process.send?.(
            { event: 'closed-with-error', message: error.message },
            () => process.disconnect(),
          );
          process.exitCode = 1;
        });
  });
  return {
    app: coreApp(context, version, config.auth),
    stop: async () => {
      if (!own) {
        await failStop();
        await stopRuntime();
        await stopSocket();
      }
    },
  };
});
if (mode === 'partial' && process.connected) process.disconnect();
