import { mkdir, writeFile } from 'node:fs/promises';
const title =
  'recording actual native sync completion waits for public reads while committed interruption sync remains owned';
const expected = [
  'recording genuine schema-v3 ended Session adopts exact snapshot and dependency custody without replay across two reopens',
  'recording legacy adoption quota preserves original Session pins and bytes and refuses new admission until honest retry',
  'recording timestamp oracle preserves six digits and distinguishes UTC offset year boundaries',
  'recording active Command capture reports the whole HTTP SQL operation and exact accepted fact without changing no-Recording budgets',
  'recording retained reads enforce identities, Lab binding and delete CSRF while preserving bytes',
  'recording sparse trusted reports preserve independent microsecond watermarks and omit rejected facts',
  'recording relative clock backward step preserves paused source, durable ACK and renewed ticket',
  'recording relative clock forward step preserves paused source, durable ACK and renewed ticket',
  'recording selected bytes survive sparse live delivery and exact duplicate ACK',
  'recording ACK-only network loss retries exact uncertain packet without duplicate append',
  'recording boundary rejects changed pose with identical sequence/time A=1000',
  'recording boundary rejects changed pose with identical sequence/time A=3000',
  'recording write failure preserves external durable bytes and interrupts without further ACK',
  'recording pending command baseline preserves original input and idempotent acceptance',
  'recording actual SIGKILL after prepared recovers only witnessed command events with exact timestamps',
  'recording actual SIGKILL after committed recovers only witnessed command events with exact timestamps',
  'recording shared resource deletion releases only its owner and deletion tombstone survives reopen',
  'recording acknowledged bytes survive actual stopped-directory backup and new-directory restore',
  'recording completed Task survives actual kill before marker while physics stays paused at A=1000',
  'recording successor readiness write failure leaves no active unrecorded Reset Session',
  'recording Reset capture handoff accounts for a concurrent ordinary Command exactly once',
  'recording managed publication survives revocation of the initiating Agent credential',
  'recording oracle matches literal high-epoch packet and rejects altered ACK/content',
  'recording Reset post-commit marker failure compensates successor without restart or Lab blockage',
  'recording actual Core publication failure retains ACKed candidate identity and bytes through retry and second reopen',
  'recording actual native write completion hold bounds ordinary caller during idle Pause and retains owned writer',
  'recording actual native sync completion hold bounds ordinary caller during idle Pause and retains owned writer',
  'recording actual native sync completion waits for public reads while committed interruption sync remains owned',
];
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
          /(recording-legacy\.test\.ts|recording-reliability\.test\.ts|recording-machine\.ts|recording-public-support\.ts):([0-9]+):([0-9]+)/g,
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
  const exactPrefix =
    selected.length === 28 &&
    selected.every(
      (row, index) => row.title === expected[index] && row.status !== 'skipped',
    ) &&
    totals?.tests === 28 &&
    totals.skipped === 0 &&
    totals.cancelled === 0 &&
    startupFailures.length === 0 &&
    unexpectedCompletions === 0 &&
    targetExactOne;
  const earliestFailure =
    selected.find((row) => row.status === 'failed') ?? null;
  const allPassed =
    exactPrefix && selected.every((row) => row.status === 'passed');
  const summary = {
    candidate: process.env.DIAGNOSTIC_HEAD,
    scope:
      'Original legacy 4 then reliability 1-24 through exact target; no raw output/errors',
    selected,
    startupFailures,
    unexpectedCompletions,
    totals,
    exactPrefix,
    targetExactOne,
    targetOutcome:
      targetExactOne && totals?.cancelled === 0
        ? targetRows[0].status
        : 'unknown',
    earliestFailure,
    allPassed,
    verdict: !exactPrefix
      ? 'selection-or-startup-failure'
      : earliestFailure && earliestFailure.title !== title
        ? 'prefix-case-failure'
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
  if (!exactPrefix) process.exitCode = 1;
  yield JSON.stringify({
    exactPrefix,
    targetExactOne,
    verdict: summary.verdict,
    targetOutcome: summary.targetOutcome,
    earliestFailure: earliestFailure
      ? { title: earliestFailure.title, status: earliestFailure.status }
      : null,
    totals,
  }) + '\n';
}
