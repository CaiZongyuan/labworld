import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { ContractResources } from './lib/contract-resources.mjs';
import { launch, root } from './lib/process.mjs';

const args = process.argv.slice(2),
  profiles = args.length
    ? [args]
    : readdirSync(join(root, 'tests/e2e'))
        .filter((name) => name.endsWith('.spec.ts'))
        .sort()
        .map((name) => ['tests/e2e/' + name]),
  resources = new ContractResources(
    join(
      root,
      '.scratch/vnext-m1',
      'browser-suite-' + randomUUID(),
      'owned-resources.json',
    ),
    randomUUID(),
    false,
  );
resources.data.owner = 'Node desktop browser profile supervisor';
resources.save();
resources.snapshot('start');
let active,
  closed = false;
async function stop() {
  closed = true;
  resources.data.closing = true;
  resources.save();
  if (active?.pid) await resources.stop(active.pid);
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    void stop();
  });
try {
  for (const profile of profiles) {
    if (closed) throw new Error('Browser suite was cancelled');
    const intent = resources.planConsumer('owned-node-browser-profile');
    active = launch(
      process.execPath,
      ['--experimental-strip-types', 'scripts/e2e-server.mjs', ...profile],
      {
        ...process.env,
        CONTRACT_RUN_ID: resources.data.runId,
        CONTRACT_CONSUMER_MARKER: intent.marker,
      },
    );
    resources.launchedConsumer(intent.id, active.pid);
    const [code] = await once(active, 'exit');
    await resources.stop(active.pid);
    active = undefined;
    if (code !== 0) throw new Error('Owned Node browser profile failed');
  }
  resources.data.state = 'completed';
} catch (error) {
  resources.data.state = 'failed';
  throw error;
} finally {
  await stop();
  resources.reconcile('browser-suite-complete');
  resources.snapshot('end');
  console.log('Node browser suite ledger: ' + resources.path);
}
