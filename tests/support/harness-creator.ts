import { ServerProcess } from './server-process.ts';
const target = await new ServerProcess().create();
target.entry = 'tests/support/prelease-child.ts';
target.beforeIdentity = async () => {
  process.send?.({
    ledger: target.evidence + '/owned-resources.json',
    childPid: target.child!.pid,
    directory: target.directory,
  });
  await new Promise<void>(() => {});
};
await target.spawn();
