import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  processIdentity,
  sameProcess,
  recoverServerResources,
  type ServerLedger,
} from './server-resources.ts';

const root = '.scratch/vnext-m1';
mkdirSync(root, { recursive: true });
const names = readdirSync(root).filter((name) =>
  /^lab-word-m1-[0-9A-Za-z]+$/.test(name),
);
const checks: object[] = [];
let closed = true;
for (const name of names) {
  const path = join(root, name, 'owned-resources.json');
  try {
    if (!existsSync(path)) throw new Error('Missing owned ledger');
    let row = JSON.parse(readFileSync(path, 'utf8')) as ServerLedger;
    if (row.state !== 'cleaned') row = await recoverServerResources(path);
    const creator = await processIdentity(row.creator.pid);
    const value = {
      fixture: name,
      cleaned: row.state === 'cleaned',
      directoryCleared: row.directory === '',
      processes: row.processes.length,
      inProcessConsumers: row.inProcessConsumers?.length ?? 0,
      launchIntent: !!row.launchIntent,
      docker: row.docker.length,
      creatorStopped: !creator || !sameProcess(creator, row.creator),
    };
    if (
      !value.cleaned ||
      !value.directoryCleared ||
      value.processes ||
      value.inProcessConsumers ||
      value.launchIntent ||
      value.docker ||
      !value.creatorStopped
    )
      closed = false;
    checks.push(value);
  } catch {
    closed = false;
    checks.push({ fixture: name, reconciliation: 'unknown' });
  }
}
writeFileSync(
  join(root, 'test-resource-reconciliation.json'),
  JSON.stringify(
    {
      actualOwnedLedgerCount: names.length,
      resourcesClosed: closed,
      checks,
      globalPostVmInventory:
        'unavailable; actual owned ledger and creator checks only',
    },
    null,
    2,
  ) + '\n',
);
if (!closed) process.exitCode = 1;
