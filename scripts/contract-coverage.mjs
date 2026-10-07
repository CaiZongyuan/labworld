import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { root } from './lib/process.mjs';
const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    output: { type: 'string', default: '.scratch/vnext-m0/coverage.json' },
  },
});
if (!values.manifest)
  throw new Error(
    'Provide a suite manifest or explicit verified batch manifest',
  );
const manifest = JSON.parse(
  readFileSync(resolve(root, values.manifest), 'utf8'),
);
const matrix = JSON.parse(
  readFileSync(resolve(root, 'tests/contract/behavior-matrix.json'), 'utf8'),
);
const passed = new Set();
const batches = [];
for (const entry of manifest.profiles) {
  const ledgerPath = resolve(root, entry.ledger);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const reportPath = ledgerPath.replace('owned-resources.json', 'results.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (
    ledger.state !== 'completed' ||
    ledger.reconciliations.at(-1).consumers.some((consumer) => consumer.alive)
  )
    throw new Error('Batch resources are not reconciled');
  if (
    ledger.containers.some(
      (container) => !['cleaned', 'absent'].includes(container.state),
    )
  )
    throw new Error('Batch retains temporary containers');
  const assertions = report.testResults
    .flatMap((file) => file.assertionResults)
    .filter((assertion) => assertion.status === 'passed');
  for (const assertion of assertions) passed.add(assertion.title.split(' ')[0]);
  if (report.numFailedTests || report.numFailedTestSuites || !assertions.length)
    throw new Error('Batch is not a passing collected contract');
  batches.push({
    profile: entry.profile,
    batch: entry.batch,
    report: reportPath,
    ledger: ledgerPath,
    passed: assertions.length,
    skipped: report.numPendingTests,
    resourceState: ledger.state,
    reuse: entry.reuse ?? null,
  });
}
const rows = matrix.rows.map((row) => {
  if (row.classification === 'internal-supplement') {
    if (
      !row.supplement?.issue ||
      !row.supplement?.owner ||
      !row.supplement.checks?.length
    )
      throw new Error(`Unassigned supplement: ${row.id}`);
    return {
      id: row.id,
      classification: row.classification,
      result: 'assigned-supplement',
      supplement: row.supplement,
    };
  }
  if (row.classification === 'gap')
    throw new Error(`Required public gap: ${row.id}`);
  const missing = row.tests.filter((id) => !passed.has(id));
  if (!row.tests.length || missing.length)
    throw new Error(
      `Required row lacks observed pass: ${row.id} ${missing.join(',')}`,
    );
  return {
    id: row.id,
    classification: row.classification,
    result: 'passed',
    tests: row.tests,
  };
});
const result = {
  baseline: matrix.baseline,
  target: manifest.target ?? null,
  targetSource:
    manifest.target === undefined
      ? 'legacy-metadata-incomplete'
      : 'suite-manifest',
  descriptor: manifest.descriptor ?? null,
  observedAt: new Date().toISOString(),
  totalUniquePassed: passed.size,
  totalExecutedPassed: batches.reduce((sum, batch) => sum + batch.passed, 0),
  batches,
  rows,
  requiredPublicGaps: [],
};
writeFileSync(
  resolve(root, values.output),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  `Required rows passed: ${passed.size} unique contracts; ${batches.length} reconciled batches`,
);
