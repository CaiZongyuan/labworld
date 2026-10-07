import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ServerProcess, until } from '../support/server-process.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';

for (const mode of ['partial', 'stop'] as const)
  test(
    'real lifecycle owners drain after ' +
      mode +
      ' failure before directory ownership ends',
    { timeout: 20000 },
    async () => {
      const target = await new ServerProcess().create();
      target.entry = 'tests/support/runtime-owner-failure.ts';
      target.ipc = true;
      const ledger = join(target.evidence, 'lifecycle-owned-resources.json');
      target.env = {
        APP_ORIGIN: target.url,
        OWNED_LIFECYCLE_MODE: mode,
        OWNED_LIFECYCLE_LEDGER: ledger,
      };
      const events: Array<{ event: string; message?: string }> = [];
      try {
        await target.spawn();
        target.child!.on('message', (event) =>
          events.push(event as { event: string; message?: string }),
        );
        if (mode === 'stop') {
          await until(
            () => fetch(target.url + '/health/live'),
            (response) => response.ok,
            10000,
          );
          target.child!.send('owned-stop');
        }
        await until(
          async () => target.child!.exitCode,
          (code) => code !== null,
          6500,
        );
        assert.equal(target.child!.exitCode, 1);
        const facts = JSON.parse(await readFile(ledger, 'utf8'));
        assert.ok(
          facts.resources.every(
            (resource: { state: string }) => resource.state === 'stopped',
          ),
          'every real acquired owner was stopped despite failure',
        );
        if (mode === 'stop')
          assert.ok(
            events.some(
              (event) =>
                event.event === 'closed-with-error' &&
                event.message?.includes('Owned first stop failure'),
            ),
          );
        else assert.ok(target.logs.includes('Owned later preparation failure'));
        const lease = await DirectoryLease.acquire(target.directory);
        await lease.release();
      } finally {
        await target.cleanup();
        const facts = JSON.parse(await readFile(ledger, 'utf8'));
        facts.creatorReconciliation =
          'actual owned primary process stopped; OS handles released by supervisor';
        await writeFile(ledger, JSON.stringify(facts, null, 2));
      }
    },
  );
