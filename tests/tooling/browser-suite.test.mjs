import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
for (const cleanupFailure of [false, true])
  test(
    `browser suite ${cleanupFailure ? 'aborts after unconfirmed cleanup' : 'continues after a cleaned failed profile and retains a failing result'}`,
    { skip: process.platform !== 'linux' },
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'lab-browser-suite-'));
      const events = join(directory, 'events.jsonl');
      try {
        const child = spawnSync(process.execPath, ['scripts/e2e-suite.mjs'], {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            NODE_OPTIONS: `--import ${new URL('./fixtures/browser-profile-preload.mjs', import.meta.url).href}`,
            LAB_BROWSER_FIXTURE_EVENTS: events,
            LAB_BROWSER_FIXTURE_CLEANUP_FAILURE: String(cleanupFailure),
          },
        });
        assert.equal(child.status, 1);
        const attempted = readFileSync(events, 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        if (cleanupFailure) assert.equal(attempted.length, 1);
        else assert.equal(attempted[1].index, 1);
        assert.equal(
          attempted.every(
            (entry) => !live(entry.pid) && !live(entry.descendant),
          ),
          true,
        );
        const ledgerPath = child.stdout.match(
          /Node browser suite ledger: (.+)/,
        )?.[1];
        assert.ok(ledgerPath, child.stderr);
        const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
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
        if (!cleanupFailure) {
          const aggregate = JSON.parse(
            readFileSync(join(ledgerPath, '..', 'results.json'), 'utf8'),
          );
          assert.equal(aggregate.profiles[0].summary.status, 'failed');
          assert.equal(aggregate.profiles[1].summary.status, 'passed');
          assert.equal(aggregate.status, 'failed');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
