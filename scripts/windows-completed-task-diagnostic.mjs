// One real Windows original case; checked c471 failure-only startup observer.
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  copyFile,
  writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';

const file = 'tests/e2e/recording-reliability.test.ts';
const title =
  'recording completed Task survives actual kill before marker while physics stays paused at A=1000';
const source = await readFile(file, 'utf8');
const titles = [...source.matchAll(/\btest\(\s*'([^']+)'/g)];
const selected = titles.filter((match) => match[1] === title);
if (selected.length !== 1)
  throw new Error('Expected exactly one original completed-Task case');
const pattern = '^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
const root = '.scratch/windows-completed-task-diagnostic';
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'run-'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(revision.stdout))
  throw new Error('Candidate commit was not resolved');
const summary = {
  base: '314b551e145c55602bec17d05fb9f8eee2e35850',
  candidate: revision.stdout.trim(),
  platform: process.platform,
  node: process.version,
  target: {
    file,
    title,
    declaredLine: source.slice(0, selected[0].index).split('\n').length,
    pattern,
  },
  inputs: {
    caseTimeoutMs: 120000,
    fixtureAckMillis: 1000,
    existingDMillis: 333,
  },
  selectedLiteralTitles: 1,
  verdict: 'discovery-only',
  failures: [],
  failureLogs: [],
  cleanup: [],
};
const save = () =>
  writeFile(
    join(directory, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
const phases = new Set([
  'database-initialize',
  'core-prepare',
  'files-initialize',
  'source-presence-initialize',
  'recording-initialize',
  'devices-initialize',
  'sessions-initialize',
  'recording-recover-legacy',
  'sources-initialize',
  'serve',
]);
const codes = new Set([
  'lab.recording_gate_timeout',
  'lab.recording_prepare_timeout',
  'lab.recording_read_timeout',
  'lab.recording_event_prepare_timeout',
  'lab.recording_event_commit_timeout',
  'lab.recording_event_abort_timeout',
  'lab.recording_drain_timeout',
  'lab.recording_seal_timeout',
  'lab.recording_ack_timeout',
  'UNKNOWN',
]);
const observeFailures = (text) => {
  for (const line of text.split('\n')) {
    const event = line.match(/(\{"event":"server.start_diagnostic"[^\n]*?\})/);
    if (!event) continue;
    try {
      const value = JSON.parse(event[1]);
      if (
        phases.has(value.phase) &&
        codes.has(value.code) &&
        summary.failures.length < 16 &&
        !summary.failures.some(
          (previous) =>
            previous.phase === value.phase && previous.code === value.code,
        )
      )
        summary.failures.push({
          phase: value.phase,
          code: value.code,
          observedBeforeRuntimeTeardown: true,
        });
    } catch {
      /* Preserve the original error and verdict if observation is incomplete. */
    }
  }
};
const fixtureRoot = '.scratch/vnext-m1';
const fixtures = async () =>
  (await readdir(fixtureRoot).catch(() => [])).filter((name) =>
    name.startsWith('lab-word-m1-'),
  );
if (process.argv.includes('--discover')) {
  await save();
  console.log(JSON.stringify(summary));
} else {
  if (process.platform !== 'win32')
    throw new Error('This probe requires actual Windows');
  const before = new Set(await fixtures());
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      '--experimental-strip-types',
      '--test-reporter=./tests/support/recording-startup-safe-reporter.mjs',
      '--test-name-pattern=' + pattern,
      file,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RECORDING_DIAGNOSTIC_OUTPUT: directory,
        RECORDING_DIAGNOSTIC_EXPECT_SELECTED: '1',
        LAB_WORD_WINDOWS_RECOVERY_DIAGNOSTIC: 'true',
      },
    },
  );
  // Reporter emits closed JSON only; no child message/output is retained here.
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', () => {});
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => child.kill(signal));
  const [exitCode, signal] = await once(child, 'close');
  summary.exitCode = exitCode;
  summary.signal =
    signal === null || ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal)
      ? signal
      : 'other';
  try {
    summary.testResult = JSON.parse(
      await readFile(join(directory, 'test-summary.json'), 'utf8'),
    );
  } catch {
    summary.nodeSummaryUnavailable = true;
  }
  for (const name of await fixtures()) {
    if (before.has(name)) continue;
    const path = join(fixtureRoot, name, 'owned-resources.json');
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    summary.cleanup.push({
      fixture: name,
      state: ledger.state,
      processes: ledger.processes?.length ?? 0,
      docker: ledger.docker?.length ?? 0,
      consumers: ledger.inProcessConsumers?.length ?? 0,
      launchIntent: !!ledger.launchIntent,
      directoryCleared: ledger.directory === '',
    });
    const ledgerDirectory = join(directory, name);
    await mkdir(ledgerDirectory, { recursive: true });
    await copyFile(path, join(ledgerDirectory, 'owned-resources.json'));
    try {
      observeFailures(
        await readFile(join(fixtureRoot, name, 'server.log'), 'utf8'),
      );
      summary.failureLogs.push({ fixture: name, state: 'read' });
    } catch (error) {
      summary.failureLogs.push({
        fixture: name,
        state: error?.code === 'ENOENT' ? 'missing' : 'unreadable',
      });
    }
  }
  const cleaned =
    summary.cleanup.length === 1 &&
    summary.cleanup.every(
      (item) =>
        item.state === 'cleaned' &&
        item.processes === 0 &&
        item.docker === 0 &&
        item.consumers === 0 &&
        !item.launchIntent &&
        item.directoryCleared,
    );
  summary.verdict = !summary.testResult?.exactOne
    ? 'collection-mismatch'
    : !cleaned
      ? 'cleanup-unconfirmed'
      : exitCode === 0
        ? 'original-case-passed-non-reproduction'
        : 'original-case-failed';
  await save();
  console.log(JSON.stringify(summary));
  process.exitCode =
    summary.verdict === 'original-case-passed-non-reproduction'
      ? 0
      : exitCode || 1;
}
