import { once } from 'node:events';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractResources } from './lib/contract-resources.mjs';
import { TlsTestOwner } from './lib/tls-test-owner.mjs';
import { launch, root } from './lib/process.mjs';
import { recoverServerResources } from '../tests/support/server-resources.ts';

async function reconcileChild(resources) {
  const pointer = resources.data.childLedgerPointer;
  if (!pointer || !existsSync(pointer)) return;
  const child = JSON.parse(readFileSync(pointer, 'utf8'));
  resources.data.childLedgers = child;
  resources.save();
  const browser = new ContractResources(child.browserLedger);
  const state = browser.reconcile('wss-parent-readback');
  if (state.consumers.some((consumer) => consumer.alive))
    await browser.recover();
  for (const path of child.serviceLedgers) {
    const service = JSON.parse(readFileSync(path, 'utf8'));
    if (service.state !== 'cleaned') await recoverServerResources(path);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--recover') {
  if (args.length !== 2) throw new Error('Use --recover <owned ledger>');
  const resources = new ContractResources(args[1]);
  await resources.recover();
  await reconcileChild(resources);
  TlsTestOwner.recover(resources);
  process.exit(0);
}
const resources = new ContractResources(
  join(
    root,
    '.scratch/vnext-m1',
    'wss-' + randomUUID(),
    'owned-resources.json',
  ),
  randomUUID(),
  false,
);
resources.data.owner = 'Trusted local HTTPS/WSS browser supervisor';
resources.snapshot('start');
resources.data.childLedgerPointer = join(
  dirname(resources.path),
  'child-ledgers.json',
);
resources.save();
const tls = new TlsTestOwner(
  resources,
  mkdtempSync(join(tmpdir(), 'lab-word-wss-')),
);
let child,
  closing,
  stopped = false;
async function close() {
  if (closing) return closing;
  stopped = true;
  resources.data.closing = true;
  resources.save();
  closing = (async () => {
    if (child?.pid) await resources.stop(child.pid);
    await reconcileChild(resources);
    const reconciliation = resources.reconcile('before-trust-removal');
    if (reconciliation.consumers.some((consumer) => consumer.alive))
      throw new Error('Owned browser consumers remain; CA trust preserved');
    tls.cleanup();
    resources.snapshot('end');
  })();
  return closing;
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
try {
  const trust = await tls.prepare();
  if (stopped) throw new Error('TLS supervisor cancelled before admission');
  const intent = resources.planConsumer('trusted-https-wss-browser-profile');
  child = launch(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/e2e-server.mjs',
      ...(args.length ? args : ['tests/e2e/lab-secure-motion.spec.ts']),
    ],
    {
      ...process.env,
      E2E_TLS: 'true',
      LAB_WORD_TLS_CERT: trust.cert,
      LAB_WORD_TLS_KEY: trust.key,
      NODE_EXTRA_CA_CERTS: trust.ca,
      SSL_CERT_FILE: trust.ca,
      WSS_CHILD_LEDGER_POINTER: resources.data.childLedgerPointer,
      CONTRACT_RUN_ID: resources.data.runId,
      CONTRACT_CONSUMER_MARKER: intent.marker,
    },
  );
  resources.launchedConsumer(intent.id, child.pid);
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('Trusted HTTPS/WSS profile failed');
  resources.data.state = 'completed';
} catch (error) {
  resources.data.state = 'failed';
  throw error;
} finally {
  await close();
  if (
    process.env.LAB_NODE_BROWSER_PROFILE_RESULT &&
    existsSync(process.env.LAB_NODE_BROWSER_PROFILE_RESULT)
  ) {
    const path = process.env.LAB_NODE_BROWSER_PROFILE_RESULT;
    const closure = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      JSON.stringify({
        ...closure,
        tlsLedger: resources.path,
        tlsCleanupCompleted: resources.data.tls?.state === 'cleaned',
      }) + '\n',
      { mode: 0o600 },
    );
  }
  console.log('Trusted HTTPS/WSS ownership: ' + resources.path);
}
