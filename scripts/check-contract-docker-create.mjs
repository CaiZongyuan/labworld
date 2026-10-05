import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './lib/process.mjs';
const id = `docker-create-${randomUUID().slice(0, 8)}`;
const directory = resolve(root, '.scratch/vnext-m0', id);
mkdirSync(directory);
const bin = resolve(directory, 'bin');
mkdirSync(bin);
const realDocker = execFileSync('which', ['docker'], {
  encoding: 'utf8',
}).trim();
const ready = resolve(directory, 'ready'),
  release = resolve(directory, 'release');
writeFileSync(
  resolve(bin, 'docker'),
  `#!/usr/bin/env bash\nif [[ "$1" == run ]]; then\n  touch "$CONTRACT_DOCKER_DELAY_READY"\n  while [[ ! -f "$CONTRACT_DOCKER_DELAY_RELEASE" ]]; do sleep 0.1; done\nfi\nexec "${realDocker}" "$@"\n`,
  { mode: 0o755 },
);
const ledger = resolve(
  root,
  `.scratch/vnext-m0/runs/${id}/owned-resources.json`,
);
const supervisor = spawn(
  process.execPath,
  ['scripts/contract.mjs', '--no-build', '--lifecycle-probe', '--run-id', id],
  {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CONTRACT_DOCKER_DELAY_READY: ready,
      CONTRACT_DOCKER_DELAY_RELEASE: release,
    },
    stdio: 'inherit',
  },
);
const exit = new Promise((resolveExit) => supervisor.once('exit', resolveExit));
const read = () => JSON.parse(readFileSync(ledger, 'utf8'));
async function recover() {
  const process = spawn(
    globalThis.process.execPath,
    ['scripts/contract.mjs', '--recover', ledger],
    { cwd: root, env: globalThis.process.env, stdio: 'inherit' },
  );
  return new Promise((resolveExit) => process.once('exit', resolveExit));
}
try {
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready) && Date.now() < deadline) await delay(50);
  assert(existsSync(ready));
  const before = read();
  assert.equal(before.containers.length, 1);
  assert.equal(before.containers[0].state, 'planned');
  const creator = before.consumers.find(
    (consumer) => consumer.role === 'docker-create-process-group',
  );
  assert(creator?.pid);
  supervisor.kill('SIGKILL');
  await exit;
  process.kill(creator.pid, 0);
  assert.equal(await recover(), 0);
  const result = read();
  assert.equal(result.state, 'recovered');
  assert(
    result.reconciliations
      .at(-1)
      .consumers.every((consumer) => !consumer.alive),
  );
  writeFileSync(release, 'released');
  const actual = execFileSync(
    realDocker,
    [
      'ps',
      '-a',
      '--filter',
      `label=labword.contract.run=${id}`,
      '--format',
      '{{.ID}}',
    ],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(actual, '');
  writeFileSync(
    resolve(root, '.scratch/vnext-m0/docker-create-result.json'),
    JSON.stringify(
      {
        runId: id,
        ledger,
        result: 'passed',
        meaning:
          'creator CLI stopped before delayed creation release; no late resource',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Delayed Docker creation is stopped before recovery finishes');
} finally {
  if (supervisor.exitCode === null && supervisor.signalCode === null)
    supervisor.kill('SIGKILL');
  await exit;
  if (existsSync(ledger) && read().state !== 'recovered') await recover();
}
