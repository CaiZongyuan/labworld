import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { root } from './lib/process.mjs';
import { ContractResources } from './lib/contract-resources.mjs';

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
      } catch {
        /* ledger has not been created yet */
      }
      if (
        data?.stage === (mode.endsWith('-wait') ? mode : 'target-ready') &&
        (mode !== 'consumer-orphan' ||
          existsSync(resolve(directory, 'orphan-child.pid')))
      )
        break;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Probe exited before ready');
      await delay(100);
    }
    assert.equal(
      read(ledger).stage,
      mode.endsWith('-wait') ? mode : 'target-ready',
    );
    const beforeActive = readFileSync(ledger);
    const beforeMtime = statSync(ledger).mtimeMs;
    await assert.rejects(
      new ContractResources(ledger).recover(),
      /active supervisor/,
    );
    assert.deepEqual(readFileSync(ledger), beforeActive);
    assert.equal(statSync(ledger).mtimeMs, beforeMtime);
    assert(!existsSync(`${ledger}.next`));
    const invalid = read(ledger);
    invalid.supervisor.token = '';
    const invalidPath = resolve(directory, 'invalid-proof.json');
    writeFileSync(invalidPath, JSON.stringify(invalid));
    const invalidBytes = readFileSync(invalidPath);
    const invalidMtime = statSync(invalidPath).mtimeMs;
    assert.throws(
      () => new ContractResources(invalidPath),
      /Invalid owned resource ledger/,
    );
    assert.deepEqual(readFileSync(invalidPath), invalidBytes);
    assert.equal(statSync(invalidPath).mtimeMs, invalidMtime);
    if (mode === 'signal' || mode.endsWith('-wait')) child.kill('SIGTERM');
    if (
      mode === 'orphan-recover' ||
      mode === 'orphan-restart' ||
      mode === 'consumer-orphan'
    ) {
      const data = read(ledger);
      const wrapper = data.consumers.find(
        (entry) =>
          entry.role ===
          (mode === 'consumer-orphan'
            ? 'non-api-probe-group'
            : 'target-process-group'),
      );
      let apiPid = Number(
        readFileSync(
          resolve(
            directory,
            mode === 'consumer-orphan' ? 'orphan-child.pid' : 'api.pid',
          ),
          'utf8',
        ),
      );
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
      if (mode === 'consumer-orphan')
        assert(
          !wrapper.members.some((member) => member.pid === apiPid),
          'descendant must be born after the only recorded membership sample',
        );
      child.kill('SIGKILL');
      process.kill(wrapper.pid, 'SIGKILL');
      await delay(100);
      process.kill(apiPid, 0); // The original group descendant is still alive.
      await exit;
      process.kill(apiPid, 0);
      if (mode === 'consumer-orphan') {
        const wrong = read(ledger);
        wrong.consumers.find(
          (entry) => entry.role === 'non-api-probe-group',
        ).marker = randomUUID();
        const wrongPath = resolve(directory, 'wrong-consumer-proof.json');
        writeFileSync(wrongPath, JSON.stringify(wrong));
        await assert.rejects(
          new ContractResources(wrongPath).recover(),
          /identity cannot be proved/,
        );
        process.kill(apiPid, 0);
      }
      if (mode === 'consumer-orphan') {
        const unregistered = read(ledger);
        const intent = unregistered.consumers.find(
          (entry) => entry.role === 'non-api-probe-group',
        );
        delete intent.pid;
        delete intent.token;
        intent.members = [];
        intent.state = 'planned';
        writeFileSync(ledger, JSON.stringify(unregistered, null, 2) + '\n');
      }
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
    assert.equal(before.docker, 'not-used');
    assert.equal(after.docker, 'not-used');
    checks.push({ mode, runId, ledger, outcome: 'passed' });
    writeFileSync(
      resolve(root, '.scratch/vnext-m0/lifecycle-results.json'),
      JSON.stringify(checks, null, 2) + '\n',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    await Promise.race([exit, delay(10_000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    const data = read(ledger);
    if (!['recovered', 'interrupted'].includes(data.state)) {
      // Recovery validates stored process identity and refuses historical Docker ledgers.
      const recovery = spawn(
        process.execPath,
        ['scripts/contract.mjs', '--recover', ledger],
        { cwd: root, env: process.env, stdio: 'inherit' },
      );
      await new Promise((resolveExit) => recovery.once('exit', resolveExit));
    }
  }
}
const selected = process.argv.slice(2);
for (const mode of selected.length
  ? selected
  : [
      'signal',
      'timeout',
      'orphan-recover',
      'orphan-restart',
      'consumer-orphan',
      'register-wait',
    ])
  await probe(mode);
writeFileSync(
  resolve(root, '.scratch/vnext-m0/lifecycle-results.json'),
  JSON.stringify(checks, null, 2) + '\n',
);
console.log(`${checks.length} actual Node supervisor lifecycle checks passed`);
