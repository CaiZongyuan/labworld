import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

test(
  'the ordinary contract runner isolates owned Node settings from exported development settings',
  { timeout: 20000, skip: process.platform !== 'linux' },
  async () => {
    const sentinel = await new ServerProcess().create();
    const runner = await new ServerProcess().create();
    const runId = 'environment-' + randomUUID();
    const ledger = resolve(
      '.scratch/vnext-m0/runs',
      runId,
      'owned-resources.json',
    );
    await writeFile(
      join(sentinel.directory, 'keep.txt'),
      'owned sentinel before-state',
    );
    const before = (await readdir(sentinel.directory)).sort();
    runner.entry = 'scripts/contract.mjs';
    runner.args = ['--lifecycle-probe', '--run-id', runId, '--timeout', '8'];
    runner.env = {
      LAB_WORD_DATA_DIR: sentinel.directory,
      SERVER_PORT: String(sentinel.port),
      LAB_WORD_HOST: '127.0.0.1',
      APP_ORIGIN: sentinel.url,
      FILE_PUBLIC_ORIGIN: sentinel.url,
      RATE_LIMIT_ENABLED: 'false',
      RATE_LIMIT_AUTHENTICATION: '1',
      RATE_LIMIT_AUTHENTICATION_FALLBACK: '1',
    };
    try {
      await runner.spawn();
      let stage: string | undefined;
      await until(
        async () => {
          try {
            stage = JSON.parse(await readFile(ledger, 'utf8')).stage;
          } catch {
            // The owned runner has not published its ledger yet.
          }
          return stage === 'target-ready' || runner.child!.exitCode !== null;
        },
        (settled) => settled,
        12000,
      );
      assert.deepEqual((await readdir(sentinel.directory)).sort(), before);
      assert.equal(
        await readFile(join(sentinel.directory, 'keep.txt'), 'utf8'),
        'owned sentinel before-state',
      );
      assert.equal(stage, 'target-ready');
      const current = JSON.parse(
        await readFile('.scratch/vnext-m0/current.json', 'utf8'),
      );
      assert.equal(current.runId, runId);
      const recorded = JSON.parse(await readFile(ledger, 'utf8'));
      const bind = recorded.consumers.find(
        (consumer: { role: string }) =>
          consumer.role === 'target-process-group',
      ).bind;
      const ownedUrl = 'http://' + bind;
      assert.notEqual(ownedUrl, sentinel.url);
      assert.equal(
        (await lstat(join(current.directory, 'data/pgdata'))).isDirectory(),
        true,
      );
      assert.equal((await fetch(ownedUrl + '/health/ready')).status, 200);
      const client = new CoreHttp(ownedUrl);
      await client.login(
        'contract-owner@example.test',
        'contract-isolated-password',
      );
      const metrics = await client.json<{
        enabled: boolean;
        policies: { policy: string; limit: number }[];
      }>('GET', '/api/v1/system/rate-limits');
      assert.equal(metrics.enabled, true);
      assert.equal(
        metrics.policies.find((policy) => policy.policy === 'authentication')
          ?.limit,
        60,
      );
    } finally {
      await runner.stop();
      await runner.cleanup();
      await sentinel.cleanup();
    }
  },
);
