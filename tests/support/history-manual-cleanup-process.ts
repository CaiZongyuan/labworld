import { run } from '../../apps/server/src/runtime.ts';

// The manual-cleanup journey owns deletion; all other runtime owners stay live.
await run(undefined, {
  ownHistoryMaintenance: (stop) => stop(),
});
