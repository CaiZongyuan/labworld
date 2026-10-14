import { mkdir, writeFile } from 'node:fs/promises';

const selectedName =
  'the normal Python source entrypoint reports presence without sampling a GPU and releases only its connection';
const errorClasses = new Set([
  'Error',
  'AssertionError',
  'TypeError',
  'SyntaxError',
]);
const errorCodes = new Set([
  'ERR_ASSERTION',
  'ERR_TEST_FAILURE',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
]);

// Original assertions may carry private child output as an Error message.
// This diagnostic reporter projects only their verdict and closed metadata.
export default async function* report(events) {
  const results = [];
  const startupFailures = [];
  let totals = null;
  for await (const { type, data } of events) {
    if (type === 'test:summary') {
      totals = {
        tests: data.counts.tests,
        passed: data.counts.passed,
        failed: data.counts.failed,
        skipped: data.counts.skipped,
      };
    }
    if (!['test:pass', 'test:fail'].includes(type)) continue;
    const error = data.details?.error?.cause ?? data.details?.error;
    if (data.name !== selectedName) {
      if (type === 'test:fail')
        startupFailures.push({
          errorClass: errorClasses.has(error?.name)
            ? error.name
            : error
              ? 'other'
              : null,
          errorCode: errorCodes.has(error?.code)
            ? error.code
            : error
              ? 'other'
              : null,
        });
      continue;
    }
    const stack = typeof error?.stack === 'string' ? error.stack : '';
    const locations = [
      ...stack.matchAll(/source-client\.test\.ts:(\d+):(\d+)/g),
    ]
      .slice(0, 8)
      .map((match) => ({
        file: 'source-client.test.ts',
        line: Number(match[1]),
        column: Number(match[2]),
      }));
    const result = {
      test: 'original-normal-python-source-client',
      status: data.skip
        ? 'skipped'
        : type === 'test:pass'
          ? 'passed'
          : 'failed',
      durationMs: Number.isFinite(data.details?.duration_ms)
        ? data.details.duration_ms
        : null,
      errorClass: errorClasses.has(error?.name)
        ? error.name
        : error
          ? 'other'
          : null,
      errorCode: errorCodes.has(error?.code)
        ? error.code
        : error
          ? 'other'
          : null,
      locations,
    };
    results.push(result);
    yield JSON.stringify(result) + '\n';
  }
  const summary = {
    purpose:
      'Single original Windows source client diagnostic; raw output and error messages discarded',
    selectedName,
    selected: results,
    startupFailures,
    totals,
    selectedCollected: results.length === 1,
    selectedPassed: results.length === 1 && results[0].status === 'passed',
  };
  if (
    process.env.SOURCE_CLIENT_DIAGNOSTIC_EXPECT_SELECTED === '1' &&
    (!summary.selectedCollected || results[0].status === 'skipped')
  )
    process.exitCode = 1;
  await mkdir('.scratch/source-client-windows', { recursive: true });
  await writeFile(
    '.scratch/source-client-windows/test-summary.json',
    JSON.stringify(summary, null, 2) + '\n',
  );
  yield JSON.stringify({
    selectedCollected: summary.selectedCollected,
    selectedPassed: summary.selectedPassed,
    totals,
  }) + '\n';
}
