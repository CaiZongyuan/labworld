import { mkdir, writeFile } from 'node:fs/promises';
const title =
  'recording actual native sync completion waits for public reads while committed interruption sync remains owned';
const predecessor =
  'recording actual native sync completion hold bounds ordinary caller during idle Pause and retains owned writer';
const expected = [predecessor, title];
const classes = new Set([
  'Error',
  'AssertionError',
  'TypeError',
  'SyntaxError',
  'RangeError',
]);
const codes = new Set([
  'ERR_ASSERTION',
  'ERR_TEST_FAILURE',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
]);
export default async function* report(events) {
  const selected = [],
    startupFailures = [];
  let totals = null;
  let unexpectedCompletions = 0;
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
          ? 'unknown'
          : null,
      errorCode: codes.has(error?.code) ? error.code : error ? 'unknown' : null,
    };
    if (!expected.includes(data.name)) {
      unexpectedCompletions++;
      if (type === 'test:fail') startupFailures.push(failure);
      continue;
    }
    const stack = typeof error?.stack === 'string' ? error.stack : '';
    selected.push({
      title: data.name,
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
        ...stack.matchAll(
          /(recording-reliability\.test\.ts|recording-machine\.ts|recording-public-support\.ts):([0-9]+):([0-9]+)/g,
        ),
      ]
        .slice(0, 8)
        .map((value) => ({
          file: value[1],
          line: Number(value[2]),
          column: Number(value[3]),
        })),
    });
  }
  const targetRows = selected.filter((row) => row.title === title);
  const targetExactOne =
    targetRows.length === 1 && targetRows[0].status !== 'skipped';
  const exactTwo =
    selected.length === 2 &&
    selected.every(
      (row, index) => row.title === expected[index] && row.status !== 'skipped',
    ) &&
    totals?.tests === 2 &&
    totals.skipped === 0 &&
    totals.cancelled === 0 &&
    startupFailures.length === 0 &&
    unexpectedCompletions === 0 &&
    targetExactOne;
  const summary = {
    candidate: process.env.DIAGNOSTIC_HEAD,
    scope:
      'Original immediate native-sync predecessor then exact original target; no raw output/errors',
    selected,
    startupFailures,
    unexpectedCompletions,
    totals,
    exactTwo,
    targetExactOne,
    targetOutcome: exactTwo ? targetRows[0].status : 'unknown',
    verdict: !exactTwo
      ? 'selection-or-startup-failure'
      : selected[0].status === 'failed'
        ? 'predecessor-case-failure'
        : targetRows[0].status === 'passed'
          ? 'non-reproduction'
          : 'original-case-failure',
  };
  await mkdir('.scratch/windows-pause-diagnostic', { recursive: true });
  await writeFile(
    '.scratch/windows-pause-diagnostic/test-summary.json',
    JSON.stringify(summary, null, 2) + '\n',
    { mode: 0o600 },
  );
  if (!exactTwo) process.exitCode = 1;
  yield JSON.stringify({
    exactTwo,
    targetExactOne,
    verdict: summary.verdict,
    targetOutcome: summary.targetOutcome,
    totals,
  }) + '\n';
}
