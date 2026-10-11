import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { ContractResources } from '../../scripts/lib/contract-resources.mjs';
import { launch } from '../../scripts/lib/process.mjs';
import { saveAssociation } from './reconcile-association.mjs';
import { verifyFrozenInputs } from './verify.mjs';
const bundle = dirname(new URL(import.meta.url).pathname);
const evidence = resolve('.scratch/early-handle-ci-evidence');
mkdirSync(evidence, { recursive: true });
mkdirSync('.scratch/vnext-m1', { recursive: true });
process.env.CAMERA_DIAGNOSTIC_EVIDENCE = evidence;
const manifest = verifyFrozenInputs();
const associationPath = resolve(evidence, 'association.json');
const args = [
  '--config',
  '.scratch/early-handle-ci/playwright.config.ts',
  '.scratch/early-handle-ci/early-handle.spec.ts',
];
saveAssociation(associationPath, {
  state: 'authorized-starting',
  owner: 'One GitHub Actions camera prefix',
  diagnosticRunHead: process.env.DIAGNOSTIC_RUN_HEAD ?? null,
  productCommit: manifest.productCommit,
  productTree: manifest.productTree,
  existingSuiteNames: readdirSync('.scratch/vnext-m1', {
    withFileTypes: true,
  })
    .filter((d) => d.name.startsWith('browser-suite-'))
    .map((d) => d.name),
  ownedLedgers: [],
  immutableFirstSeenServices: {},
  command: ['node', 'scripts/e2e-suite.mjs', ...args],
  versions: {
    node: process.version,
    pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    playwright: execFileSync('pnpm', ['exec', 'playwright', '--version'], {
      encoding: 'utf8',
    }).trim(),
  },
  environment: {
    E2E_LAB_REFERENCE_LOAD: process.env.E2E_LAB_REFERENCE_LOAD ?? null,
    E2E_WEB_MODE: process.env.E2E_WEB_MODE ?? null,
    LAB_WORD_MIGRATION_DESKTOP: process.env.LAB_WORD_MIGRATION_DESKTOP ?? null,
  },
  browserEnvironment: {
    chromiumVersion:
      'UNKNOWN: no extra browser or protocol observation authorized',
    effectiveBackendFlags:
      'UNKNOWN: launcher parent environment is recorded; actual child flags require retained supervisor evidence',
    ordinaryLaunchConfiguration:
      'Frozen playwright.config.ts Desktop Chrome project; no launchOptions override',
    equivalenceLimit:
      'Pinned toolchain/install and declared parent environment only; actual browser/backend equivalence is not established',
  },
  runner: Object.fromEntries(
    ['RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion', 'RUNNER_NAME'].map(
      (k) => [k, process.env[k] ?? null],
    ),
  ),
});
execFileSync('python3', [resolve(bundle, 'inventory.py'), 'before'], {
  stdio: 'inherit',
});
const resources = new ContractResources(
  resolve(evidence, 'launcher-owned-resources.json'),
  randomUUID(),
  false,
);
resources.data.owner = 'One-shot camera diagnostic launcher';
resources.save();
const startup = JSON.parse(readFileSync(associationPath, 'utf8'));
startup.launcherLedger = resources.path;
startup.launcherSupervisor = resources.data.supervisor;
saveAssociation(associationPath, startup);
let suite, watcher, stopPromise;
function stop() {
  return (stopPromise ??= (async () => {
    if (suite?.pid) await resources.stop(suite.pid);
    if (watcher?.pid) await resources.stop(watcher.pid);
  })());
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void stop();
  });
let code = 1;
try {
  const watchIntent = resources.planConsumer(
    'immutable-camera-association-watcher',
  );
  watcher = launch('python3', [resolve(bundle, 'association-watch.py')], {
    ...process.env,
    CONTRACT_RUN_ID: resources.data.runId,
    CONTRACT_CONSUMER_MARKER: watchIntent.marker,
  });
  resources.launchedConsumer(watchIntent.id, watcher.pid);
  const intent = resources.planConsumer('original-camera-suite');
  suite = launch(process.execPath, ['scripts/e2e-suite.mjs', ...args], {
    ...process.env,
    CONTRACT_RUN_ID: resources.data.runId,
    CONTRACT_CONSUMER_MARKER: intent.marker,
  });
  resources.launchedConsumer(intent.id, suite.pid);
  [code] = await once(suite, 'exit');
  resources.data.state = code === 0 ? 'completed' : 'failed';
} finally {
  await stop();
  resources.reconcile('diagnostic-launcher-complete');
  resources.snapshot('end');
  const association = JSON.parse(readFileSync(associationPath, 'utf8'));
  association.launcherLedger = resources.path;
  association.exitCode = code;
  association.launcherSupervisor = resources.data.supervisor;
  association.launcherConsumers = resources.data.consumers;
  saveAssociation(associationPath, association);
}
process.exitCode = code ?? 1;
