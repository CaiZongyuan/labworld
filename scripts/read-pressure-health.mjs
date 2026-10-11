import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPressureSealAck } from '../tests/support/pressure-barrier.ts';

const [probe] = process.argv.slice(2);
assert(probe, 'Use <owned-probe-dir>');
const proof = JSON.parse(
  readFileSync(join(probe, 'seal-barrier.json'), 'utf8'),
);
assert.equal(proof.valid, true, 'Missing/failed current-owner sealed ACKs');
for (const role of ['server', 'source', 'peer'])
  assertPressureSealAck(proof.replies?.[role], {
    request_id: proof.request_id,
    pid: proof.expectedOwners[role],
    afterGeneration: proof.baselineGenerations[role],
    requestedAt: proof.requestedAt,
  });
console.log(
  'PASS current server/source/peer sealed-window ACKs; no exit marker credit',
);
