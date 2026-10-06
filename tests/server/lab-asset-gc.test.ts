import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AssetPage,
  DownloadCapability,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import {
  beginAsset,
  publishAsset,
  rewriteGlb,
} from '../support/lab-assets-http.ts';
test('actual rejected upload bytes retire while provisional metadata still rejects replay and durable ready content remains exact', async () => {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/lab-maintenance-process.ts';
  target.ipc = true;
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  target.env.UPLOAD_SESSION_SECS = '2';
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const client = new CoreHttp(target.url);
    await client.register('member@example.test');
    const bytes = await readFile(
        new URL('../fixtures/lab/cube.glb', import.meta.url),
      ),
      ready = await publishAsset(client, bytes, 'Durable ready'),
      before = await client.json<AssetPage>('GET', '/api/v1/lab/assets');
    const bad = rewriteGlb(bytes, (root) => {
        root.scenes = [];
      }),
      attempt = await beginAsset(client, bad, 'Rejected bytes');
    await client.error(
      'POST',
      attempt.path,
      undefined,
      422,
      'files.upload_rejected',
    );
    const hash = attempt.input.file.sha256,
      path = join(target.directory, 'blobs', 'objects', hash.slice(0, 2), hash);
    assert.deepEqual(await readFile(path), bad);
    await until(
      async () => Date.now(),
      (now) => now >= Date.parse(attempt.upload.upload!.expires_at),
      5000,
    );
    const maintained = new Promise<void>((resolve) => {
      const receive = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'stage' in message &&
          message.stage === 'maintenance-done'
        ) {
          target.child!.off('message', receive);
          resolve();
        }
      };
      target.child!.on('message', receive);
    });
    target.child!.send('owned-maintain');
    await maintained;
    await assert.rejects(
      stat(path),
      (error) =>
        error instanceof Error && 'code' in error && error.code === 'ENOENT',
    );
    await client.error(
      'POST',
      '/api/v1/lab/asset-uploads',
      attempt.input,
      422,
      'files.upload_rejected',
      attempt.headers,
    );
    await client.error(
      'POST',
      attempt.path,
      undefined,
      422,
      'files.upload_rejected',
    );
    assert.deepEqual(
      await client.json<AssetPage>('GET', '/api/v1/lab/assets'),
      before,
    );
    const download = await client.json<DownloadCapability>(
      'GET',
      `/api/v1/lab/assets/${ready.id}/download`,
    );
    const response = await fetch(download.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    console.log(
      JSON.stringify({
        event: 'm3a.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});
