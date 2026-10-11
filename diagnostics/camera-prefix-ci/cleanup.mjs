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
  reconcileAssociation,
  saveAssociation,
} from './reconcile-association.mjs';
import {
  recoverServerResources,
  processIdentity,
  sameProcess,
} from '../../tests/support/server-resources.ts';
const evidence = resolve('.scratch/camera-prefix-ci-evidence');
const associationPath = resolve(evidence, 'association.json');
if (!existsSync(associationPath)) {
  if (existsSync(resolve(evidence, 'launcher-owned-resources.json'))) {
    writeFileSync(
      resolve(evidence, 'always-closure.json'),
      JSON.stringify({
        cleanupCompleted: false,
        finalOwnershipReconciliation: {
          complete: false,
          missing: [
            {
              boundary: 'association',
              reason:
                'Launcher ledger exists but its association is unavailable; preserve resources',
            },
          ],
        },
      }) + '\n',
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
    throw new Error(
      'Launcher ownership exists without association; closure incomplete',
    );
  }
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
  const launcherData = existsSync(launcher)
    ? JSON.parse(readFileSync(launcher, 'utf8'))
    : { consumers: [] };
  reconcileAssociation(association, launcherData);
  saveAssociation(associationPath, association);
  if (association.suiteLedger)
    await new ContractResources(association.suiteLedger).recover();
  reconcileAssociation(association, launcherData);
  saveAssociation(associationPath, association);
  for (const [i, path] of (association.ownedLedgers ?? []).entries())
    copyFileSync(
      path,
      resolve(
        retained,
        `final-${i}-${path.split('/').at(-2)}-${path.split('/').at(-1)}`,
      ),
    );
  for (const path of [association.browserLedger].filter(Boolean))
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
  const serviceProofs = [
    ...Object.values(association.immutableFirstSeenServices ?? {}),
    ...Object.values(association.terminalObservedServices ?? {}).map(
      (proof) => ({
        ...proof,
        originalDirectory: proof.directoryAtTerminalObservation,
      }),
    ),
  ];
  for (const proof of serviceProofs) {
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
      ledger.directory ||
      ledger.launchIntent ||
      ledger.inProcessConsumers?.length ||
      (proof.originalDirectory && existsSync(proof.originalDirectory))
    )
      throw new Error('Owned diagnostic service cleanup incomplete');
  }
  const finalOwnership = reconcileAssociation(association, launcherData);
  saveAssociation(associationPath, association);
  if (!finalOwnership.complete)
    throw new Error(
      'Owned diagnostic graph is incomplete; inspect finalOwnershipReconciliation.missing',
    );
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
        terminalObservedServices: association.terminalObservedServices,
        finalOwnershipReconciliation:
          association.finalOwnershipReconciliation ?? null,
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
