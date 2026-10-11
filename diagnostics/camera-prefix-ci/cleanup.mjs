import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ContractResources } from '../../scripts/lib/contract-resources.mjs';
import {
  recoverServerResources,
  processIdentity,
  sameProcess,
} from '../../tests/support/server-resources.ts';
const evidence = resolve('.scratch/camera-prefix-ci-evidence');
const associationPath = resolve(evidence, 'association.json');
if (!existsSync(associationPath)) {
  console.log('Diagnostic never launched; no owned runtime ledger');
  process.exit(0);
}
const association = JSON.parse(readFileSync(associationPath, 'utf8'));
const retained = resolve(evidence, 'retained');
mkdirSync(retained, { recursive: true });
const paths = [
  associationPath,
  resolve(evidence, 'launcher-owned-resources.json'),
  ...(association.ownedLedgers ?? []),
];
for (const [i, path] of paths.entries())
  if (existsSync(path))
    copyFileSync(
      path,
      resolve(
        retained,
        `${i}-${dirname(path).split('/').at(-1)}-${path.split('/').at(-1)}`,
      ),
    );
// Recovery validates creator/process birth tokens and preserves unknown or active owners.
const launcher = resolve(evidence, 'launcher-owned-resources.json');
const receipts = [];
let cleanupCompleted = false;
try {
  if (existsSync(launcher)) await new ContractResources(launcher).recover();
  for (const path of [
    association.suiteLedger,
    association.browserLedger,
  ].filter(Boolean))
    await new ContractResources(path).recover();
  for (const path of association.serviceLedgers ?? []) {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    if (ledger.state !== 'cleaned') await recoverServerResources(path);
  }
  for (const path of [
    launcher,
    association.suiteLedger,
    association.browserLedger,
  ].filter((p) => p && existsSync(p))) {
    const resources = new ContractResources(path);
    resources.reconcile('ci-diagnostic-always-closure');
    const reconciliation = resources.data.reconciliations.at(-1);
    if (reconciliation.consumers.some((c) => c.alive || c.actualMembers.length))
      throw new Error('Owned diagnostic consumer remains active');
    receipts.push({ path, runId: resources.data.runId, reconciliation });
  }
  for (const proof of Object.values(
    association.immutableFirstSeenServices ?? {},
  )) {
    for (const original of [
      ...proof.processProofs,
      ...(proof.inProcessConsumerProofs ?? []).map((p) => p.creator),
    ]) {
      const actual = await processIdentity(original.pid);
      if (actual && sameProcess(actual, original))
        throw new Error('Immutable owned service identity remains active');
    }
    const ledger = JSON.parse(readFileSync(proof.ledger, 'utf8'));
    if (
      ledger.state !== 'cleaned' ||
      ledger.processes.length ||
      existsSync(proof.originalDirectory)
    )
      throw new Error('Owned diagnostic service cleanup incomplete');
  }
  cleanupCompleted = true;
} finally {
  writeFileSync(
    resolve(evidence, 'always-closure.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        diagnosticRunHead: association.diagnosticRunHead,
        productCommit: association.productCommit,
        receipts,
        services: association.serviceLedgers,
        immutableFirstSeenServices: association.immutableFirstSeenServices,
        cleanupCompleted,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  process.env.CAMERA_DIAGNOSTIC_EVIDENCE = evidence;
  execFileSync(
    'python3',
    [
      resolve(dirname(new URL(import.meta.url).pathname), 'inventory.py'),
      'after',
    ],
    { stdio: 'inherit' },
  );
}
