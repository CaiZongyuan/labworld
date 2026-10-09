#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../lib/process.mjs';
import {
  project,
  requireDocker,
  requireK6,
  startSampler,
  startStack,
  stopStack,
} from './stack.mjs';
import { humanLine, saturationHint, saturationLine } from './report.mjs';

// Runs one load scenario end to end: brings up the controlled stack
// (scripts/perf/stack.mjs), seeds the fixture dataset (scripts/perf/
// fixtures.mjs), drives the k6 scenario, samples pool/queue/RSS while it
// runs, and writes everything a reader needs to reproduce the numbers to
// .scratch/perf/<scenario>-report.json.
//
// This is report material per spec §17.3 — nightly/release cadence, never
// a PR gate, and no wall-clock number here is a threshold. The only hard
// expectations are the k6 thresholds inside the steady-state scenarios (a
// run that drowns in real business errors is not a reading), which fail the
// command but still leave the report on disk.

const SCENARIOS = {
  // vus/durationSecs mirror each scenario's scenarioOptions defaults (they
  // seed the PERF_VUS/PERF_DURATION overrides) — keep the two in sync.
  load: { file: 'load.js', seed: true, vus: 4, durationSecs: 60 },
  saturation: { file: 'saturation.js', seed: true, ladder: true },
  trajectory: {
    file: 'trajectory.js',
    seed: false,
    selfRegistering: true,
    vus: 2,
    durationSecs: 60,
  },
  soak: { file: 'soak.js', seed: true, vus: 2, durationSecs: 600 },
};

const scenario = process.argv[2];
if (!SCENARIOS[scenario]) {
  console.error(
    `Usage: node scripts/perf/run-scenario.mjs <${Object.keys(SCENARIOS).join('|')}>`,
  );
  process.exit(1);
}
const definition = SCENARIOS[scenario];

requireDocker();
requireK6();

const scratch = join(root, '.scratch', 'perf');
mkdirSync(scratch, { recursive: true });
const reportPath = join(scratch, `${scenario}-report.json`);

const saturationSteps = () =>
  (process.env.PERF_STEPS ?? '1,4,8,16,32')
    .split(',')
    .map((step) => Number(step.trim()))
    .filter((step) => step > 0);
const saturationStepSeconds = () => Number(process.env.PERF_STEP_SECS ?? 20);

// k6 exits non-zero when a threshold fails — that is a failed run, but the
// summary (and therefore the report) is still written and still matters.
// The child is awaited, not execFileSync'd: a synchronous child would block
// this runner's event loop and starve the sampler's interval for the whole
// run, leaving the report with no stack samples to speak of.
async function runK6(stack, { file, vus, durationSecs, summaryPath }) {
  const env = {
    ...process.env,
    K6_NO_USAGE_REPORT: 'true',
    PERF_BASE_URL: `http://127.0.0.1:${stack.apiPort}`,
    PERF_SUMMARY: summaryPath,
    PERF_SCENARIO: scenario,
    PERF_VUS: String(vus),
    PERF_DURATION: `${durationSecs}s`,
    ...(definition.seed
      ? { PERF_USERS_FILE: join(scratch, 'fixtures-users.json') }
      : {}),
  };
  const startedAt = new Date().toISOString();
  const child = spawn(
    'k6',
    ['run', '--quiet', join(root, 'scripts', 'perf', 'k6', file)],
    {
      cwd: root,
      env,
      stdio: 'inherit',
    },
  );
  const failed = await new Promise((resolve) => {
    child.on('error', () => resolve(true));
    child.on('close', (code) => resolve(code !== 0));
  });
  return {
    vus,
    durationSecs,
    startedAt,
    endedAt: new Date().toISOString(),
    failed,
  };
}

function readSummary(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { error: 'summary file missing or unreadable' };
  }
}

let stack;
const sampler = startSampler();
const windows = [];
let fixtures = null;
let stackError = null;
try {
  stack = await startStack();
  sampler.watch(stack.children.api, 'api');
  sampler.watch(stack.children.worker, 'worker');

  if (definition.seed) {
    const { seed } = await import('./fixtures.mjs');
    fixtures = await seed(`http://127.0.0.1:${stack.apiPort}`);
  }

  if (definition.ladder) {
    for (const vus of saturationSteps()) {
      const durationSecs = saturationStepSeconds();
      console.log(`[saturation] step: ${vus} VUs for ${durationSecs}s`);
      const summaryPath = join(scratch, `saturation-step-${vus}.json`);
      const window = await runK6(stack, {
        file: definition.file,
        vus,
        durationSecs,
        summaryPath,
      });
      windows.push({ ...window, summary: readSummary(summaryPath) });
      rmSync(summaryPath);
    }
  } else {
    const durationSecs = Number(
      process.env.PERF_DURATION ?? definition.durationSecs,
    );
    const vus = Number(process.env.PERF_VUS ?? definition.vus);
    const summaryPath = join(scratch, `${scenario}-summary.json`);
    const window = await runK6(stack, {
      file: definition.file,
      vus,
      durationSecs,
      summaryPath,
    });
    windows.push({ ...window, summary: readSummary(summaryPath) });
    rmSync(summaryPath);
  }
} catch (error) {
  stackError = error;
} finally {
  var samples = await sampler.stop();
  await stopStack(stack?.children);
}

if (stackError !== null || windows.length === 0) {
  const failure = {
    scenario,
    generatedBy: 'scripts/perf/run-scenario.mjs',
    failed: true,
    error: String(stackError),
    samples,
  };
  writeFileSync(reportPath, `${JSON.stringify(failure, null, 2)}\n`);
  console.error(
    `Scenario did not run to completion; failure report: ${reportPath}`,
  );
  process.exit(1);
}

// The report's rateLimits line quotes the stack's own env, so the numbers
// on record are what the binaries actually ran with — not a second copy of
// the values that could drift.
const rateLimits =
  'registration/authentication/resource ' +
  [
    stack.env.RATE_LIMIT_REGISTRATION,
    stack.env.RATE_LIMIT_AUTHENTICATION,
    stack.env.RATE_LIMIT_RESOURCE,
  ].join('/') +
  ` per ${stack.env.RATE_LIMIT_WINDOW_SECS}s (capacity readings, not throttle exercises)`;

const report = {
  scenario,
  generatedBy: 'scripts/perf/run-scenario.mjs',
  project,
  startedAt: windows[0].startedAt,
  durationMs: windows.reduce(
    (total, w) => total + (Date.parse(w.endedAt) - Date.parse(w.startedAt)),
    0,
  ),
  failed: windows.some((w) => w.failed),
  environment: {
    scale: process.env.PERF_SCALE ?? 'sm',
    vus: windows.map((w) => w.vus),
    durationSecs: definition.ladder
      ? windows.map((w) => w.durationSecs)
      : windows[0].durationSecs,
    rateLimits,
  },
  fixtures:
    fixtures ??
    (definition.selfRegistering
      ? { note: 'the trajectory registers its own users, one per iteration' }
      : null),
  k6: definition.ladder
    ? { steps: windows.map(({ summary, ...rest }) => ({ ...rest, summary })) }
    : windows[0].summary,
  saturation: definition.ladder ? saturationHint(windows) : undefined,
  samples,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `\n${scenario}: ${definition.ladder ? saturationLine(windows) : humanLine(windows[0].summary)}`,
);
if (definition.ladder)
  console.log(`saturation hint: ${JSON.stringify(report.saturation)}`);
console.log(`report: ${reportPath}`);
if (windows.some((w) => w.failed)) {
  console.error(
    'At least one run failed its k6 thresholds — the report records what happened.',
  );
  process.exit(1);
}
