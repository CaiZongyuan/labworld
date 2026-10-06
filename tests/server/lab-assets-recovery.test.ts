import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type {
  AssetPage,
  LabAsset,
  DownloadCapability,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import {
  beginAsset,
  publishAsset,
  rewriteGlb,
} from '../support/lab-assets-http.ts';
async function member(target: ServerProcess) {
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  await target.start();
  await new CoreHttp(target.url).register('owner@example.test');
  const client = new CoreHttp(target.url);
  await client.register('member@example.test');
  assert.equal(client.session!.user.role, 'member');
  return client;
}
const cube = () =>
  readFile(new URL('../fixtures/lab/cube.glb', import.meta.url));
const library = (client: CoreHttp) =>
  client.json<AssetPage>('GET', '/api/v1/lab/assets');
test('permanent GLB rejection refuses the original upload intent and a fresh valid upload recovers', async () => {
  const target = await new ServerProcess().create();
  try {
    const client = await member(target),
      before = await library(client),
      bytes = await cube();
    const malformed = rewriteGlb(bytes, (root) => {
      root.scenes = [];
    });
    const attempt = await beginAsset(client, malformed, 'Rejected scene');
    await client.error(
      'POST',
      attempt.path,
      undefined,
      422,
      'files.upload_rejected',
    );
    await client.error(
      'POST',
      '/api/v1/lab/asset-uploads',
      attempt.input,
      422,
      'files.upload_rejected',
      attempt.headers,
    );
    assert.deepEqual(await library(client), before);
    const recovered = await publishAsset(client, bytes, 'Recovered scene');
    assert.notEqual(recovered.representation.file_id, attempt.upload.upload_id);
    assert.deepEqual((await library(client)).data, [recovered]);
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
test('a real embedded PNG data URI keeps MIME and base64 case normalization and exact uploaded bytes', async () => {
  const target = await new ServerProcess().create();
  try {
    const client = await member(target),
      bytes = await cube(),
      png = await readFile(
        new URL(
          '../../apps/web/public/lab-assets/hdr/studio-thumbnail.png',
          import.meta.url,
        ),
      );
    const encoded = rewriteGlb(bytes, (root) => {
      root.images = [
        { uri: `data:IMAGE/PNG;BASE64,${png.toString('base64')}` },
      ];
    });
    const asset = await publishAsset(client, encoded, 'Embedded PNG');
    const download = await client.json<DownloadCapability>(
      'GET',
      `/api/v1/lab/assets/${asset.id}/download`,
    );
    const response = await fetch(download.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), encoded);
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
test('raw forbidden rename controls refuse without changing metadata and valid trimmed text recovers', async () => {
  const target = await new ServerProcess().create();
  try {
    const client = await member(target),
      asset = await publishAsset(client, await cube(), 'Stable name'),
      before = await library(client),
      path = `/api/v1/lab/assets/${asset.id}`;
    await client.error(
      'PATCH',
      path,
      { name: '\nValid' },
      400,
      'lab.invalid_input',
    );
    assert.deepEqual(await client.json<LabAsset>('GET', path), asset);
    assert.deepEqual(await library(client), before);
    const renamed = await client.json<LabAsset>('PATCH', path, {
      name: ' Valid ',
    });
    assert.equal(renamed.name, 'Valid');
    assert.deepEqual(renamed.representation, asset.representation);
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
test('a real codec read outage returns availability failure and the same process and upload recover', async () => {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/lab-codec-fault.ts';
  target.ipc = true;
  try {
    const client = await member(target),
      before = await library(client),
      attempt = await beginAsset(client, await cube(), 'Recoverable codec');
    await client.error(
      'POST',
      attempt.path,
      undefined,
      503,
      'files.unavailable',
    );
    assert.deepEqual(await library(client), before);
    const restored = new Promise<void>((resolve) => {
      const receive = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'stage' in message &&
          message.stage === 'codec-restored'
        ) {
          target.child!.off('message', receive);
          resolve();
        }
      };
      target.child!.on('message', receive);
    });
    target.child!.send('restore-codec');
    await restored;
    const recovered = await client.json<LabAsset>('POST', attempt.path);
    assert.equal(recovered.representation.file_id, attempt.upload.upload_id);
    assert.deepEqual((await library(client)).data, [recovered]);
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
