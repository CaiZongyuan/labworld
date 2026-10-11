import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLab334Seal } from '../tests/support/lab334-observation.ts';
const [evidence, runLog] = process.argv.slice(2);
assert(
  evidence && runLog,
  'Use <actual owned evidence> <actual owned run log>',
);
const messages = readFileSync(runLog, 'utf8')
  .split('\n')
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const owners = messages.filter((row) => row.event === 'lab334.observer.owner');
assert.equal(owners.length, 1, 'Missing unique actual probe owner');
const owner = owners[0];
const ledger = JSON.parse(
  readFileSync(join(evidence, 'browser-owned-resources.json'), 'utf8'),
);
assert.equal(owner.runId, ledger.runId, 'Wrong actual owned run');
const final = messages.filter(
  (row) =>
    row.event === 'lab334.observer.sealed' &&
    row.caseNonce === owner.caseNonce &&
    row.ownerPid === owner.ownerPid,
);
assert.equal(final.length, 1, 'Missing unique actual current sealed health');
assert.equal(final[0].health.valid, true, 'Latched observation failure');
const proof = JSON.parse(
  readFileSync(
    join(evidence, 'lab334-' + owner.caseNonce, 'sealed-window.json'),
    'utf8',
  ),
);
assert.equal(proof.caseNonce, owner.caseNonce);
assert.equal(proof.nodeOwner.pid, owner.ownerPid);
assert.equal(proof.nodeOwner.runId, owner.runId);
assert.equal(proof.observerHealth.valid, true);
assert(
  Number.isSafeInteger(proof.capturedAt) && proof.capturedAt <= Date.now(),
);
for (const view of proof.owners) {
  assert.equal(view.available === false, false);
  assertLab334Seal(view, {
    requestId: proof.requestId,
    caseNonce: owner.caseNonce,
    pageId: view.pageId,
    requestedAt: proof.requestedAt,
    receivedAt: proof.capturedAt,
  });
}
assert.deepEqual(proof.owners.map((row) => row.role).sort(), [
  'first',
  'runner',
  'second',
]);
console.log(
  'PASS actual owned Lab334 sealed observer evidence; original predicate result unchanged',
);
