import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function live(pid) {
  try {
    return (
      readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0] !==
      'Z'
    );
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function runSuite(args, { cleanupFailure = false, env = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lab-browser-suite-'));
  const events = join(directory, 'events.jsonl');
  try {
    const child = spawnSync(
      process.execPath,
      ['scripts/e2e-suite.mjs', ...args],
      {
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          ...env,
          NODE_OPTIONS: `--import ${new URL('./fixtures/browser-profile-preload.mjs', import.meta.url).href}`,
          LAB_BROWSER_FIXTURE_EVENTS: events,
          LAB_BROWSER_FIXTURE_CLEANUP_FAILURE: String(cleanupFailure),
        },
      },
    );
    assert.ifError(child.error);
    const attempted = existsSync(events)
      ? readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse)
      : [];
    assert.equal(
      attempted.every((entry) => !live(entry.pid) && !live(entry.descendant)),
      true,
    );
    const ledgerPath = child.stdout.match(
      /Node browser suite ledger: (.+)/,
    )?.[1];
    return {
      child,
      attempted,
      ledger: ledgerPath ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null,
      aggregate: ledgerPath
        ? JSON.parse(
            readFileSync(join(ledgerPath, '..', 'results.json'), 'utf8'),
          )
        : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const defaultProfiles = readdirSync(new URL('../e2e', import.meta.url))
  .filter((name) => name.endsWith('.spec.ts'))
  .sort()
  .map((name) =>
    name === 'lab-synthetic-motion.spec.ts'
      ? ['tests/e2e/' + name, '--grep', 'motion smoke:']
      : ['tests/e2e/' + name],
  );

for (const shard of [null, 1, 2])
  for (const cleanupFailure of [false, true])
    test(
      `browser suite ${shard === null ? 'default' : `shard ${shard}/2`} ${cleanupFailure ? 'aborts after unconfirmed cleanup' : 'continues after a cleaned failed profile and retains a failing result'}`,
      { skip: process.platform !== 'linux' },
      () => {
        const { child, attempted, ledger, aggregate } = runSuite(
          shard === null ? [] : [`--profile-shard=${shard}/2`],
          { cleanupFailure },
        );
        assert.equal(child.status, 1);
        const expected = defaultProfiles.filter(
          (_, index) => shard === null || index % 2 === shard - 1,
        );
        assert.deepEqual(
          attempted.map((entry) => entry.args),
          cleanupFailure ? expected.slice(0, 1) : expected,
        );
        assert.deepEqual(
          attempted.map((entry) => entry.index),
          attempted.map((_, index) => index),
        );
        assert.ok(ledger, child.stderr);
        assert.equal(ledger.profileShard, shard);
        assert.deepEqual(ledger.profiles, expected);
        assert.equal(ledger.state, 'failed');
        assert.equal(
          ledger.reconciliations
            .at(-1)
            .consumers.every(
              (consumer) =>
                !consumer.alive && consumer.actualMembers.length === 0,
            ),
          true,
        );
        assert.equal(aggregate.shard, shard);
        assert.deepEqual(
          aggregate.profiles.map((profile) => profile.args),
          attempted.map((entry) => entry.args),
        );
        if (!cleanupFailure) {
          assert.equal(aggregate.profiles[0].summary.status, 'failed');
          assert.equal(aggregate.profiles[1].summary.status, 'passed');
          assert.equal(aggregate.status, 'failed');
        }
      },
    );

test(
  'explicit browser profile arguments and production mode reach one owned supervisor unchanged',
  { skip: process.platform !== 'linux' },
  () => {
    const args = [
      'tests/e2e/lab-node-assets-world.spec.ts',
      'tests/e2e/spa-deep-links.spec.ts',
    ];
    const { child, attempted, ledger } = runSuite(args, {
      env: { E2E_WEB_MODE: 'production' },
    });
    assert.equal(child.status, 1);
    assert.deepEqual(
      attempted.map((entry) => entry.args),
      [args],
    );
    assert.equal(attempted[0].webMode, 'production');
    assert.deepEqual(ledger.profiles, [args]);
    assert.equal(ledger.profileShard, null);
  },
);

for (const args of [
  ['--profile-shard'],
  ['--profile-shard='],
  ['--profile-shard=0/2'],
  ['--profile-shard=3/2'],
  ['--profile-shard=1/0'],
  ['--profile-shard=1/3'],
  ['--profile-shard=1.0/2'],
  ['--profile-shard=1/2', '--profile-shard=2/2'],
  ['--profile-shard=1/2', 'tests/e2e/audit.spec.ts'],
  ['--profile-shard=2/2', '--grep', 'motion smoke:'],
])
  test(
    `invalid profile shard invocation launches no consumer: ${args.join(' ')}`,
    { skip: process.platform !== 'linux' },
    () => {
      const { child, attempted, ledger, aggregate } = runSuite(args);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /Use --profile-shard=1\/2 or/);
      assert.deepEqual(attempted, []);
      assert.equal(ledger, null);
      assert.equal(aggregate, null);
    },
  );
