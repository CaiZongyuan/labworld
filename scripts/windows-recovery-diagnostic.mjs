// Diagnostic branch only. Runs one retained case and exposes closed failure facts.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';

const file = 'tests/server/session-authority.test.ts';
const title =
  'public archived/unavailable Installation and snapshot asset pins retain exact signed download bytes';
const source = await readFile(file, 'utf8');
const collection = [...source.matchAll(/\btest\(\s*'([^']+)'/g)];
const selected = collection.filter((match) => match[1] === title);
if (selected.length !== 1)
  throw new Error('Expected exactly one original case');
const root = '.scratch/windows-recovery-diagnostic';
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'run-'));
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (commit.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(commit.stdout))
  throw new Error('Candidate commit was not resolved');
const summary = {
  base: '379e02a66f84de2be13dfd3a3c06165aeee28443',
  candidate: commit.stdout.trim(),
  platform: process.platform,
  node: process.version,
  target: { file, title, line: 1134 },
  discoveredTitles: collection.length,
  selectedTitles: selected.length,
  selectedNumber: collection.indexOf(selected[0]) + 1,
  verdict: 'discovery-only',
  testCounts: {},
  failures: [],
  cleanup: [],
};
const save = () =>
  writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
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
  const raw = createWriteStream(join(directory, 'private-test.raw.log'), {
    flags: 'wx',
    mode: 0o600,
  });
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      '--experimental-strip-types',
      '--test-reporter=spec',
      `--test-name-pattern=^${title}$`,
      file,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let text = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      raw.write(chunk);
      text += String(chunk);
    });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => child.kill(signal));
  const [exitCode, signal] = await once(child, 'close');
  raw.end();
  await once(raw, 'finish');
  summary.exitCode = exitCode;
  summary.signal = signal;
  for (const line of text.split('\n')) {
    const count = line.match(/ℹ (tests|pass|fail|cancelled|skipped) (\d+)/);
    if (count) summary.testCounts[count[1]] = Number(count[2]);
    const event = line.match(/(\{"event":"server.start_diagnostic"[^\n]*?\})/);
    if (!event) continue;
    try {
      const value = JSON.parse(event[1]);
      if (phases.has(value.phase) && codes.has(value.code))
        summary.failures.push({ phase: value.phase, code: value.code });
    } catch {
      // Original test verdict is preserved even if an observer cannot decode.
    }
  }
  for (const name of await fixtures()) {
    if (before.has(name)) continue;
    const ledger = JSON.parse(
      await readFile(join(fixtureRoot, name, 'owned-resources.json'), 'utf8'),
    );
    summary.cleanup.push({
      fixture: name,
      state: ledger.state,
      processes: ledger.processes?.length ?? 0,
      docker: ledger.docker?.length ?? 0,
      consumers: ledger.inProcessConsumers?.length ?? 0,
      launchIntent: !!ledger.launchIntent,
    });
  }
  const cleaned =
    summary.cleanup.length === 1 &&
    summary.cleanup.every(
      (item) =>
        item.state === 'cleaned' &&
        item.processes === 0 &&
        item.docker === 0 &&
        item.consumers === 0 &&
        !item.launchIntent,
    );
  summary.verdict =
    summary.testCounts.tests !== 1
      ? 'collection-mismatch'
      : !cleaned
        ? 'cleanup-unconfirmed'
        : exitCode === 0
          ? 'original-case-passed'
          : 'original-case-failed';
  await save();
  console.log(JSON.stringify(summary));
  process.exitCode =
    summary.verdict === 'original-case-passed' ? 0 : exitCode || 1;
}
