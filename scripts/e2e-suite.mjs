import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
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
const results = [],
  summaryPath = join(root, 'test-results/summary.json');
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
  for (const [index, profile] of profiles.entries()) {
    if (closed) throw new Error('Browser suite was cancelled');
    const closurePath = join(
      dirname(resources.path),
      `profile-${index}-closure.json`,
    );
    rmSync(summaryPath, { force: true });
    const intent = resources.planConsumer('owned-node-browser-profile');
    active = launch(
      process.execPath,
      ['--experimental-strip-types', 'scripts/e2e-server.mjs', ...profile],
      {
        ...process.env,
        CONTRACT_RUN_ID: resources.data.runId,
        CONTRACT_CONSUMER_MARKER: intent.marker,
        LAB_NODE_BROWSER_PROFILE_INDEX: String(index),
        LAB_NODE_BROWSER_PROFILE_RESULT: closurePath,
      },
    );
    resources.launchedConsumer(intent.id, active.pid);
    const [code] = await once(active, 'exit');
    await resources.stop(active.pid);
    resources.reconcile(`browser-profile-${index}-stopped`);
    active = undefined;
    const summary = existsSync(summaryPath)
      ? JSON.parse(readFileSync(summaryPath, 'utf8'))
      : null;
    const preservedSummary = join(
      dirname(resources.path),
      `profile-${index}-summary.json`,
    );
    if (summary) copyFileSync(summaryPath, preservedSummary);
    const closure = existsSync(closurePath)
      ? JSON.parse(readFileSync(closurePath, 'utf8'))
      : null;
    results.push({
      index,
      exitCode: code,
      summary,
      summaryPath: summary ? preservedSummary : null,
      closurePath,
      closure,
    });
    if (closed) throw new Error('Browser suite was cancelled');
    if (
      closure?.cleanupCompleted !== true ||
      !Array.isArray(closure.serviceLedgers) ||
      (closure.browserLedger !== null &&
        typeof closure.browserLedger !== 'string') ||
      resources.data.reconciliations
        .at(-1)
        .consumers.some(
          (consumer) => consumer.alive || consumer.actualMembers.length,
        )
    )
      throw new Error(
        'Browser profile cleanup is unconfirmed; remaining profiles were not started',
      );
  }
  if (results.some((result) => result.exitCode !== 0))
    throw new Error('One or more owned Node browser profiles failed');
  resources.data.state = 'completed';
} catch (error) {
  resources.data.state = 'failed';
  throw error;
} finally {
  await stop();
  resources.reconcile('browser-suite-complete');
  resources.snapshot('end');
  writeFileSync(
    join(dirname(resources.path), 'results.json'),
    JSON.stringify(
      { status: resources.data.state, profiles: results },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log('Node browser suite ledger: ' + resources.path);
}
