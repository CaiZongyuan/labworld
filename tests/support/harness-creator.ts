import { ServerProcess, until } from './server-process.ts';
const target = await new ServerProcess().create();
target.entry = 'tests/support/prelease-child.ts';
// libuv Windows ordinary children belong to a kill-on-parent-exit Job. Detach only
// this failure fixture so the planned-but-unproved orphan really exists there.
target.detachedChildForRecoveryProof = true;
target.beforeIdentity = async () => {
  await until(
    async () => target.logs.includes('fixture.prelease_ready'),
    Boolean,
  );
  process.send?.({
    ledger: target.evidence + '/owned-resources.json',
    childPid: target.child!.pid,
    directory: target.directory,
  });
  await new Promise<void>(() => {});
};
await target.spawn();
