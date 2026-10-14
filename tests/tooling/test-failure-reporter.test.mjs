import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import report from '../support/test-failure-reporter.mjs';

const target =
  'recording actual native sync completion waits for public reads while committed interruption sync remains owned';
const file = resolve('tests/e2e/recording-reliability.test.ts');
const completion = (name, status) => ({
  type: status === 'passed' ? 'test:pass' : 'test:fail',
  data: {
    name,
    file,
    line: 1905,
    column: 1,
    details: {
      duration_ms: 1,
      ...(status === 'passed'
        ? {}
        : {
            error: {
              name: 'Error',
              code: 'ERR_TEST_FAILURE',
              failureType:
                status === 'cancelled' ? 'testAborted' : 'testCodeFailure',
            },
          }),
    },
  },
});
async function summary(rows, counts) {
  const original = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), 'test-reporter-facts-'));
  try {
    mkdirSync(join(directory, '.scratch'), { recursive: true });
    process.chdir(directory);
    async function* events() {
      for (const row of rows) yield row;
      yield { type: 'test:summary', data: { counts } };
    }
    for await (const output of report(events()))
      assert(!output.includes('unrelated'));
    return JSON.parse(
      readFileSync('.scratch/vnext-m1/test-failure-summary.json', 'utf8'),
    );
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}

test('known target pass survives unrelated later cancellation', async () => {
  const counts = { tests: 2, passed: 1, failed: 0, skipped: 0, cancelled: 1 };
  const value = await summary(
    [completion(target, 'passed'), completion('unrelated', 'cancelled')],
    counts,
  );
  assert.equal(value.targetOutcome, 'passed');
  assert.deepEqual(value.totals, counts);
});
test('known target fail survives unrelated later cancellation', async () => {
  const value = await summary(
    [completion(target, 'failed'), completion('unrelated', 'cancelled')],
    { tests: 2, passed: 0, failed: 1, skipped: 0, cancelled: 1 },
  );
  assert.equal(value.targetOutcome, 'failed');
  assert.equal(value.earliestFailure.target, true);
});
test('own cancellation, missing target and duplicate target remain unknown', async () => {
  for (const [rows, cancelled] of [
    [[completion(target, 'cancelled')], 1],
    [[completion('unrelated', 'passed')], 0],
    [[completion(target, 'passed'), completion(target, 'passed')], 0],
  ]) {
    const value = await summary(rows, {
      tests: rows.length,
      passed: rows.length - cancelled,
      failed: 0,
      skipped: 0,
      cancelled,
    });
    assert.equal(value.targetOutcome, 'unknown');
  }
});

test('target own cancellation with unknown locator is separate from startup failure', async () => {
  const event = completion(target, 'cancelled');
  delete event.data.file;
  delete event.data.line;
  const value = await summary([event], {
    tests: 1,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 1,
  });
  assert.equal(value.targetOutcome, 'unknown');
  assert.equal(value.startupFailures, 0);
  assert.equal(value.cases[0].status, 'cancelled');
});
