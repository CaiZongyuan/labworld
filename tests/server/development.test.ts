import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  reconcileDevelopmentResources,
  markedConsumers,
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from '../support/server-resources.ts';
import {
  ServerProcess,
  availablePort,
  until,
} from '../support/server-process.ts';

test(
  'the real development entrypoint starts Web; killed creator is reconciled before final proof without stopping unrelated processes or removing data',
  { timeout: 90000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'scripts/server-dev.ts';
    target.env.LAB_WORD_TEST_DEV_HOLD_FINAL_PROOF = '1';
    const webPort = await availablePort();
    target.env.WEB_PORT = String(webPort);
    const unrelated = await new ServerProcess().create();
    unrelated.entry = 'tests/support/prelease-child.ts';
    let devLedger: string | undefined;
    let original: ProcessIdentity[] = [];
    try {
      await unrelated.spawn();
      await target.start();
      const ownership = target.logs.split('\n').flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return value.event === 'development.ownership' ? [value] : [];
        } catch {
          return [];
        }
      })[0];
      assert.ok(ownership);
      devLedger = ownership.ledger;
      await assert.rejects(
        reconcileDevelopmentResources(devLedger!),
        /still active/,
      );
      const web = `http://127.0.0.1:${webPort}`;
      const ready = await until(
        async () => fetch(`${web}/health/ready`),
        (r) => r.status === 200,
      );
      assert.deepEqual(await ready.json(), { status: 'ok' });
      const status = (await (
        await fetch(`${web}/api/v1/system/status`)
      ).json()) as { service: string; database: string };
      assert.equal(status.service, 'labos-threejs-api');
      assert.equal(status.database, 'connected');
      const page = await fetch(`${web}/api-keys`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/);
      const before = JSON.parse(await readFile(devLedger!, 'utf8'));
      assert.equal(
        before.launchIntents.filter(
          (intent: { state: string; pid?: number }) =>
            intent.state === 'launched' && intent.pid,
        ).length,
        2,
      );
      assert.equal(
        before.processes.length,
        1,
        'The final CIM proof is deliberately unsaved',
      );
      original = await markedConsumers(before.marker);
      assert.equal(original.length, 2);
      await writeFile(
        join(target.directory, 'data-sentinel.txt'),
        'preserve-development-data',
      );
    } finally {
      await target.stop('SIGKILL');
      try {
        if (devLedger) {
          const beforeText = await readFile(devLedger, 'utf8');
          const replaced = JSON.parse(beforeText);
          const unrelatedProof = await processIdentity(unrelated.child!.pid!);
          assert.ok(unrelatedProof);
          replaced.processes = [unrelatedProof];
          const forged = JSON.stringify(replaced);
          await writeFile(devLedger, forged);
          try {
            await assert.rejects(
              reconcileDevelopmentResources(devLedger),
              /incarnation or marker changed/,
            );
            assert.ok(await processIdentity(unrelated.child!.pid!));
          } finally {
            assert.equal(
              await readFile(devLedger, 'utf8'),
              forged,
              'An unknown ledger change must not be overwritten',
            );
            await writeFile(devLedger, beforeText);
          }
          const reconciled = await reconcileDevelopmentResources(devLedger);
          assert.equal(reconciled.state, 'stopped');
          assert.deepEqual(reconciled.processes, []);
          assert.equal(reconciled.reconciliation!.remainingConsumers, 0);
          assert.deepEqual(await markedConsumers(reconciled.marker), []);
          for (const proof of original) {
            const current = await processIdentity(proof.pid);
            assert.ok(!current || !sameProcess(current, proof));
          }
          assert.equal(
            await readFile(join(target.directory, 'data-sentinel.txt'), 'utf8'),
            'preserve-development-data',
          );
          assert.ok(await processIdentity(unrelated.child!.pid!));
          await assert.rejects(
            fetch(`${target.url}/health/ready`, {
              signal: AbortSignal.timeout(500),
            }),
          );
          await assert.rejects(
            fetch(`http://127.0.0.1:${webPort}/`, {
              signal: AbortSignal.timeout(500),
            }),
          );
        }
      } finally {
        await unrelated.cleanup();
        await target.cleanup();
      }
    }
  },
);
