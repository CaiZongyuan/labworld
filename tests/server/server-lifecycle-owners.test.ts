import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ServerProcess, until } from '../support/server-process.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';

type LifecycleReceipt = {
  pid: number;
  resources: Array<{ name: string; port?: number; state: string }>;
  creatorReconciliation?: string;
};
async function actualReceipt(path: string): Promise<LifecycleReceipt | null> {
  try {
    const facts = JSON.parse(await readFile(path, 'utf8')) as LifecycleReceipt;
    assert.ok(Number.isInteger(facts?.pid) && facts.pid > 0);
    assert.ok(Array.isArray(facts.resources));
    assert.ok(
      facts.resources.every(
        (resource) =>
          resource &&
          typeof resource.name === 'string' &&
          typeof resource.state === 'string',
      ),
    );
    return facts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function failureFact(error: unknown) {
  return error instanceof Error
    ? { name: error.name, code: (error as NodeJS.ErrnoException).code ?? null }
    : { name: 'OtherError' };
}

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
      let stage = 'spawn';
      let originalFailure: unknown;
      let hasOriginalFailure = false;
      let failedStage: string | null = null;
      let finalizationFailure: unknown;
      try {
        await target.spawn();
        target.child!.on('message', (event) =>
          events.push(event as { event: string; message?: string }),
        );
        if (mode === 'stop') {
          stage = 'wait-for-live';
          await until(
            () => fetch(target.url + '/health/live'),
            (response) => response.ok,
            10000,
          );
          target.child!.send('owned-stop');
        }
        stage = 'wait-for-exit';
        await until(
          async () => target.child!.exitCode,
          (code) => code !== null,
          6500,
        );
        stage = 'check-exit';
        assert.equal(target.child!.exitCode, 1);
        stage = 'read-actual-owner-receipt';
        const facts = await actualReceipt(ledger);
        assert.ok(facts, 'the real acquired-owner receipt must exist');
        assert.equal(
          facts.pid,
          target.child!.pid,
          'receipt belongs to the actual child',
        );
        assert.deepEqual(
          facts.resources.map((resource) => resource.name),
          ['real DeviceRuntime', 'owned preparation socket'],
        );
        assert.ok(
          Number.isInteger(facts.resources[1].port) &&
            facts.resources[1].port! > 0,
          'the actual preparation socket was acquired',
        );
        assert.ok(
          facts.resources.every((resource) => resource.state === 'stopped'),
          'every real acquired owner was stopped despite failure',
        );
        stage = 'check-known-injected-failure';
        if (mode === 'stop')
          assert.ok(
            events.some(
              (event) =>
                event.event === 'closed-with-error' &&
                event.message?.includes('Owned first stop failure'),
            ),
          );
        else assert.ok(target.logs.includes('Owned later preparation failure'));
        stage = 'check-directory-release';
        const lease = await DirectoryLease.acquire(target.directory);
        await lease.release();
        stage = 'complete';
      } catch (error) {
        originalFailure = error;
        hasOriginalFailure = true;
        failedStage = stage;
      } finally {
        let cleanupFailure: unknown;
        let receiptFailure: unknown;
        let facts: LifecycleReceipt | null = null;
        try {
          await target.cleanup();
        } catch (error) {
          cleanupFailure = error;
        }
        try {
          facts = await actualReceipt(ledger);
          if (facts && !cleanupFailure) {
            facts.creatorReconciliation =
              'actual owned primary process stopped; OS handles released by supervisor';
            await writeFile(ledger, JSON.stringify(facts, null, 2));
          }
        } catch (error) {
          receiptFailure = error;
        }
        // Supplemental evidence never replaces the first failure or invents owners.
        await writeFile(
          join(target.evidence, 'lifecycle-finalization.json'),
          JSON.stringify(
            {
              mode,
              stage,
              failedStage,
              originalFailure: hasOriginalFailure
                ? failureFact(originalFailure)
                : null,
              cleanupFailure: cleanupFailure
                ? failureFact(cleanupFailure)
                : null,
              receiptFailure: receiptFailure
                ? failureFact(receiptFailure)
                : null,
              receiptPresent: facts !== null,
              actualResourceNames:
                facts?.resources.map((resource) => resource.name) ?? null,
              exitCode: target.child?.exitCode ?? null,
              signalCode: target.child?.signalCode ?? null,
              expectedInjectionObserved:
                mode === 'partial'
                  ? target.logs.includes('Owned later preparation failure')
                  : events.some(
                      (event) =>
                        event.event === 'closed-with-error' &&
                        event.message?.includes('Owned first stop failure'),
                    ),
              childLog: 'server.log',
              primaryLedger: 'owned-resources.json',
            },
            null,
            2,
          ),
        ).catch(() => {});
        finalizationFailure = cleanupFailure ?? receiptFailure;
      }
      if (hasOriginalFailure) throw originalFailure;
      if (finalizationFailure) throw finalizationFailure;
    },
  );
