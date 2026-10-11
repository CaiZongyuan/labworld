import { run } from '../../apps/server/src/runtime.ts';

// Private owned IPC, never an HTTP route. All production modules remain real.
// Machine/key expiry uses domain time; browser sessions retain actual SQL now().
let offset = 0;
await run(undefined, {
  clock: { now: () => new Date(Date.now() + offset).toISOString() },
});
process.on('message', (message) => {
  const request = message as { action?: string };
  if (
    request.action !== 'expire-machine-clock' &&
    request.action !== 'reset-machine-clock'
  )
    return;
  offset = request.action === 'expire-machine-clock' ? 31 * 86400 * 1000 : 0;
  process.send?.({
    event: 'machine-clock-advanced',
    now: new Date(Date.now() + offset).toISOString(),
  });
});
