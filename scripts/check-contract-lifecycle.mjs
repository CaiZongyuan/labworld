import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { root } from './lib/process.mjs';

const checks = [];
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
async function probe(mode) {
  const runId = `lifecycle-${mode}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, '.scratch/vnext-m0/runs', runId);
  const ledger = resolve(directory, 'owned-resources.json');
  const child = spawn(
    process.execPath,
    [
      'scripts/contract.mjs',
      '--no-build',
      '--lifecycle-probe',
      '--run-id',
      runId,
      '--lifecycle-barrier',
      mode,
      ...(mode === 'orphan-restart' ? ['--no-process-sampler'] : []),
      '--timeout',
      mode === 'timeout' ? '25' : '120',
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
  const exit = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  try {
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) {
      let data;
      try {
        data = read(ledger);
      } catch {}
      if (data?.stage === (mode.endsWith('-wait') ? mode : 'target-ready'))
        break;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Probe exited before ready');
      await delay(100);
    }
    assert.equal(
      read(ledger).stage,
      mode.endsWith('-wait') ? mode : 'target-ready',
    );
    if (mode === 'signal' || mode.endsWith('-wait')) child.kill('SIGTERM');
    if (mode === 'orphan-recover' || mode === 'orphan-restart') {
      const data = read(ledger);
      const wrapper = data.consumers.find(
        (entry) => entry.role === 'target-process-group',
      );
      let apiPid = Number(readFileSync(resolve(directory, 'api.pid'), 'utf8'));
      if (mode === 'orphan-restart') {
        const oldPid = apiPid;
        process.kill(oldPid, 'SIGKILL');
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          apiPid = Number(readFileSync(resolve(directory, 'api.pid'), 'utf8'));
          if (apiPid !== oldPid) break;
          await delay(25);
        }
        assert.notEqual(apiPid, oldPid);
        assert(
          !read(ledger)
            .consumers.find((entry) => entry.role === 'target-process-group')
            .members.some((member) => member.pid === apiPid),
          'fresh restarted child proof must come from the journal',
        );
      }
      process.kill(wrapper.pid, 'SIGKILL');
      await delay(100);
      process.kill(apiPid, 0); // The original group descendant is still serving.
      child.kill('SIGKILL');
      await exit;
      process.kill(apiPid, 0);
      const recovery = spawn(
        process.execPath,
        ['scripts/contract.mjs', '--recover', ledger],
        { cwd: root, env: process.env, stdio: 'inherit' },
      );
      const recovered = await new Promise((resolveExit) =>
        recovery.once('exit', resolveExit),
      );
      assert.equal(recovered, 0);
      assert.equal(read(ledger).state, 'recovered');
    } else {
      const result = await exit;
      assert.equal(result.code, 130);
      assert.equal(read(ledger).state, 'interrupted');
    }
    const result = read(ledger);
    assert(
      result.containers.every((entry) =>
        ['cleaned', 'absent'].includes(entry.state),
      ),
    );
    const reconciliation = result.reconciliations.at(-1);
    assert(reconciliation.consumers.every((entry) => !entry.alive));
    const before = result.inventories[0],
      after = result.inventories.at(-1);
    for (const field of ['containers', 'volumes', 'networks'])
      assert.deepEqual(
        after[field].map((entry) => entry.ID ?? entry.Name).sort(),
        before[field].map((entry) => entry.ID ?? entry.Name).sort(),
      );
    checks.push({ mode, runId, ledger, outcome: 'passed' });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await Promise.race([exit, delay(10_000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    const data = read(ledger);
    if (!['recovered', 'interrupted'].includes(data.state)) {
      // Recovery always validates stored process identity and container labels.
      const recovery = spawn(
        process.execPath,
        ['scripts/contract.mjs', '--recover', ledger],
        { cwd: root, env: process.env, stdio: 'inherit' },
      );
      await new Promise((resolveExit) => recovery.once('exit', resolveExit));
    }
  }
}
for (const mode of [
  'signal',
  'timeout',
  'orphan-recover',
  'orphan-restart',
  'worker-wait',
  'register-wait',
])
  await probe(mode);
writeFileSync(
  resolve(root, '.scratch/vnext-m0/lifecycle-results.json'),
  JSON.stringify(checks, null, 2) + '\n',
);
console.log('Six actual Rust supervisor lifecycle checks passed');
