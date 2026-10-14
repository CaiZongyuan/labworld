import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const title =
  'recording completed Task survives actual kill before marker while physics stays paused at A=1000';
const classes = new Set([
  'Error',
  'AssertionError',
  'TypeError',
  'SyntaxError',
]);
const codes = new Set([
  'ERR_ASSERTION',
  'ERR_TEST_FAILURE',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
]);

// Keep actual Node selection/verdict facts; discard all output and error messages.
export default async function* report(events) {
  const selected = [],
    startupFailures = [];
  let totals = null;
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
    const failure = {
      errorClass: classes.has(error?.name)
        ? error.name
        : error
          ? 'other'
          : null,
      errorCode: codes.has(error?.code) ? error.code : error ? 'other' : null,
    };
    if (data.name !== title) {
      if (type === 'test:fail') startupFailures.push(failure);
      continue;
    }
    const stack = typeof error?.stack === 'string' ? error.stack : '';
    const result = {
      test: 'original-recording-completed-task-recovery',
      status: data.skip
        ? 'skipped'
        : type === 'test:pass'
          ? 'passed'
          : 'failed',
      durationMs: Number.isFinite(data.details?.duration_ms)
        ? data.details.duration_ms
        : null,
      ...failure,
      locations: [
        ...stack.matchAll(/recording-reliability\.test\.ts:(\d+):(\d+)/g),
      ]
        .slice(0, 8)
        .map((match) => ({
          file: 'recording-reliability.test.ts',
          line: Number(match[1]),
          column: Number(match[2]),
        })),
    };
    selected.push(result);
    yield JSON.stringify(result) + '\n';
  }
  const exactOne =
    selected.length === 1 &&
    selected[0].status !== 'skipped' &&
    totals?.tests === 1;
  const summary = {
    scope: 'Original completed-Task recovery case; messages/output excluded',
    title,
    selected,
    startupFailures,
    totals,
    exactOne,
  };
  const output =
    process.env.RECORDING_DIAGNOSTIC_OUTPUT ??
    '.scratch/windows-completed-task-diagnostic/import-only';
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'test-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  if (process.env.RECORDING_DIAGNOSTIC_EXPECT_SELECTED === '1' && !exactOne)
    process.exitCode = 1;
  yield JSON.stringify({ exactOne, totals }) + '\n';
}
