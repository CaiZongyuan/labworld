import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Mandatory diagnostic-evidence readback, separate from the original case verdict.
const [probe, witnesses, serverLog] = process.argv.slice(2);
assert(
  probe && witnesses && serverLog,
  'Use <probe-dir> <source-witness-dir> <actual-server-log>',
);
const boundary = JSON.parse(
  readFileSync(
    join(
      probe,
      existsSync(join(probe, 'before-cleanup-failure.json'))
        ? 'before-cleanup-failure.json'
        : 'pressure-boundary.json',
    ),
    'utf8',
  ),
);
const notices = readFileSync(serverLog, 'utf8')
  .split('\n')
  .flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row.event === 'pressure.observer.health.final' ? [row] : [];
    } catch {
      return [];
    }
  });
assert.equal(notices.length, 1, 'Missing actual server final health log');
assert.equal(
  notices[0].diagnosticHealth.valid,
  true,
  'Server observation invalidated',
);
const tuples = boundary.tuples
  .filter((row) => row.available)
  .map((row) => row.value);
const server = tuples.find((row) => row.nodeAt !== undefined);
assert(
  server?.diagnosticHealth?.valid === true,
  'Missing valid server boundary tuple',
);
assert(
  boundary.wallMs - server.wallMs >= 0 &&
    boundary.wallMs - server.wallMs <= 5000,
  'Missing/stale server tuple',
);
for (const role of ['source', 'peer']) {
  const row = tuples.find((value) => value.role === role);
  assert(
    row?.diagnosticHealth?.valid === true,
    'Missing valid source/peer boundary tuple',
  );
  const age = boundary.wallMs - Number(BigInt(row.wallNs) / 1000000n);
  assert(age >= 0 && age <= 5000, 'Stale/future source/peer boundary tuple');
}
const health = readdirSync(witnesses).filter((name) =>
  /^(source|peer)-[0-9a-f-]{36}\.pressure-health\.json$/.test(name),
);
assert.equal(health.length, 2, 'Missing complete source/peer health receipts');
for (const name of health) {
  const row = JSON.parse(readFileSync(join(witnesses, name), 'utf8'));
  assert.equal(row.valid, true, 'Source/peer observation invalidated');
  assert(row.published > 0, 'Missing source/peer observation');
}
console.log(
  'PASS actual diagnostic logs and bounded fresh health receipts; original product verdict unchanged',
);
