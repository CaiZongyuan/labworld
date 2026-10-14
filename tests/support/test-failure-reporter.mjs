import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const target =
  'recording actual native sync completion waits for public reads while committed interruption sync remains owned';
const allowed = new Set(
  globSync([
    'tests/server/*.test.ts',
    'tests/e2e/recording-reliability.test.ts',
    'tests/e2e/recording-legacy.test.ts',
  ]).map((path) => resolve(path)),
);
const classes = new Set([
  'Error',
  'AssertionError',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'AbortError',
  'TimeoutError',
]);
const codes = new Set([
  'ERR_ASSERTION',
  'ERR_TEST_FAILURE',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ABORT_ERR',
]);
const numeric = (value) => (Number.isFinite(value) ? value : null);
export default async function* report(events) {
  const cases = [];
  let totals = null,
    startupFailures = 0;
  for await (const { type, data } of events) {
    if (type === 'test:summary')
      totals = {
        tests: data.counts.tests,
        passed: data.counts.passed,
        failed: data.counts.failed,
        skipped: data.counts.skipped,
        cancelled: data.counts.cancelled,
      };
    if (!['test:pass', 'test:fail'].includes(type)) continue;
    const error = data.details?.error?.cause ?? data.details?.error;
    const cancelled = [
      'testAborted',
      'cancelledByParent',
      'testTimeoutFailure',
    ].includes(data.details?.error?.failureType);
    const file =
      typeof data.file === 'string' && allowed.has(resolve(data.file))
        ? relative('.', resolve(data.file)).replaceAll('\\', '/')
        : null;
    if (
      type === 'test:fail' &&
      !cancelled &&
      (!file ||
        !data.line ||
        (typeof data.name === 'string' && allowed.has(resolve(data.name))))
    )
      startupFailures++;
    cases.push({
      ordinal: cases.length + 1,
      file,
      line: numeric(data.line),
      column: numeric(data.column),
      status: data.skip
        ? 'skipped'
        : cancelled
          ? 'cancelled'
          : type === 'test:pass'
            ? 'passed'
            : 'failed',
      durationMs: numeric(data.details?.duration_ms),
      target: data.name === target,
      errorClass: classes.has(error?.name)
        ? error.name
        : error
          ? 'unknown'
          : null,
      errorCode: codes.has(error?.code) ? error.code : error ? 'unknown' : null,
    });
  }
  const targets = cases.filter((row) => row.target);
  const summary = {
    scope: 'Original full server suite; safe case locators only',
    totals,
    observedCompletions: cases.length,
    startupFailures,
    earliestFailure: cases.find((row) => row.status === 'failed') ?? null,
    targetExactlyOnce: targets.length === 1,
    targetOutcome:
      targets.length === 1 && ['passed', 'failed'].includes(targets[0].status)
        ? targets[0].status
        : 'unknown',
    cases,
  };
  mkdirSync('.scratch/vnext-m1', { recursive: true });
  writeFileSync(
    '.scratch/vnext-m1/test-failure-summary.json',
    JSON.stringify(summary, null, 2) + '\n',
    { mode: 0o600 },
  );
  yield JSON.stringify({
    totals,
    startupFailures,
    targetOutcome: summary.targetOutcome,
  }) + '\n';
}
