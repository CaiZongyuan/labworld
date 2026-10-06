import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import type {
  AssetPage,
  DownloadCapability,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { beginAsset } from '../support/lab-assets-http.ts';
test('shutdown holds the actual directory lease through admitted validation after TCP closes, then publication survives reopen', async () => {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/lab-validation-barrier.ts';
  target.ipc = true;
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  let drained: Promise<void> | undefined;
  const stage = (wanted: string) =>
    new Promise<void>((resolve) => {
      const receive = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'stage' in message &&
          message.stage === wanted
        ) {
          target.child!.off('message', receive);
          resolve();
        }
      };
      target.child!.on('message', receive);
    });
  try {
    await target.start();
    const client = new CoreHttp(target.url);
    await client.register('shutdown-member@example.test');
    const bytes = await readFile(
        new URL('../fixtures/lab/cube.glb', import.meta.url),
      ),
      attempt = await beginAsset(client, bytes, 'Admitted before shutdown'),
      admitted = stage('validator-admitted');
    const completing = client.response('POST', attempt.path).then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
    await admitted;
    drained = stage('runtime-drained');
    target.child!.send('owned-stop');
    const closed = await completing;
    assert.ok(
      'error' in closed,
      'The TCP deadline closes the waiting connection',
    );
    const releasedEarly = await until(
      async () => {
        try {
          const lease = await DirectoryLease.acquire(target.directory);
          await lease.release();
          return true;
        } catch {
          return false;
        }
      },
      (value) => value,
      1000,
    ).catch(() => false);
    assert.equal(
      releasedEarly,
      false,
      'Admitted validator retains directory ownership after the TCP deadline',
    );
    target.child!.send('owned-release');
    await drained;
    target.child!.send('owned-exit');
    await until(
      async () => target.child!.exitCode,
      (code) => code !== null,
      5000,
    );
    await target.stop();
    target.entry = 'apps/server/src/main.ts';
    target.ipc = false;
    await target.start();
    await client.login('shutdown-member@example.test');
    const library = await client.json<AssetPage>('GET', '/api/v1/lab/assets');
    assert.equal(library.data.length, 1);
    assert.equal(
      library.data[0].representation.file_id,
      attempt.upload.upload_id,
    );
    const signed = await client.json<DownloadCapability>(
        'GET',
        `/api/v1/lab/assets/${library.data[0].id}/download`,
      ),
      response = await fetch(signed.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    if (target.child?.connected) {
      target.child.send('owned-release');
      await drained;
      target.child.send('owned-exit');
    }
    console.log(
      JSON.stringify({
        event: 'm3a.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});
