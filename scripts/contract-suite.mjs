import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './lib/process.mjs';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'candidate' },
    descriptor: { type: 'string' },
  },
});
if (values.target !== 'candidate')
  throw new Error('Contract target must be candidate');
const provenance = {
  target: values.target,
  descriptor: values.descriptor
    ? {
        path: resolve(root, values.descriptor),
        sha256: createHash('sha256')
          .update(readFileSync(resolve(root, values.descriptor)))
          .digest('hex'),
      }
    : null,
};
const batches = [
  {
    profile: 'baseline',
    name: 'core-api',
    files: ['core.test.ts', 'api.test.ts'],
  },
  { profile: 'baseline', name: 'world', files: ['world-assets.test.ts'] },
  { profile: 'baseline', name: 'devices', files: ['devices.test.ts'] },
  { profile: 'baseline', name: 'history', files: ['history-views.test.ts'] },
  { profile: 'baseline', name: 'sync', files: ['sse.test.ts'] },
  ...['file-ttl', 'session-ttl', 'retention', 'rate', 'capacity'].map(
    (profile) => ({ profile, name: profile, files: [] }),
  ),
];
const suiteId = `suite-${Date.now()}-${randomUUID().slice(0, 8)}`;
const results = [];
let child;
let cancelled = false;
const cancel = () => {
  cancelled = true;
  child?.kill('SIGTERM');
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
mkdirSync(resolve(root, '.scratch/vnext-m0'), { recursive: true });
const manifest = resolve(root, `.scratch/vnext-m0/${suiteId}.json`);
function save() {
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        suiteId,
        ...provenance,
        state: cancelled ? 'cancelled' : 'running',
        profiles: results,
      },
      null,
      2,
    ) + '\n',
  );
}
try {
  for (const { profile, name, files } of batches) {
    if (cancelled) throw new Error('Contract suite cancelled');
    const runId = `${suiteId}-${name}`;
    const ledger = resolve(
      root,
      `.scratch/vnext-m0/runs/${runId}/owned-resources.json`,
    );
    const entry = { profile, batch: name, runId, ledger, state: 'running' };
    results.push(entry);
    save();
    const args = [
      'scripts/contract.mjs',
      '--target',
      values.target,
      ...(values.descriptor ? ['--descriptor', values.descriptor] : []),
      '--run-id',
      runId,
      '--profile',
      profile,
      ...(results.length === 1 ? [] : ['--no-build']),
      ...files,
    ];
    child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    const exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    entry.state = exit === 0 ? 'passed' : 'failed';
    save();
    if (exit !== 0)
      throw new Error(`Required ${profile} contract profile exited ${exit}`);
    const owned = JSON.parse(readFileSync(ledger, 'utf8'));
    if (owned.state !== 'completed')
      throw new Error('Completed profile lacks resource reconciliation');
  }
  writeFileSync(
    manifest,
    JSON.stringify(
      { suiteId, ...provenance, state: 'passed', profiles: results },
      null,
      2,
    ) + '\n',
  );
  const coverage = spawn(
    process.execPath,
    [
      'scripts/contract-coverage.mjs',
      '--manifest',
      manifest,
      '--output',
      resolve(root, `.scratch/vnext-m0/coverage-${suiteId}.json`),
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
  const coverageExit = await new Promise((resolveExit) =>
    coverage.once('exit', resolveExit),
  );
  if (coverageExit !== 0)
    throw new Error(
      'Required behavior matrix lacks complete observed coverage',
    );
  console.log(`All six required contract profiles passed: ${manifest}`);
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
