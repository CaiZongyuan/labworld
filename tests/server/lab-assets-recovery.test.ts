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
import { corruptPngPixelStream } from '../support/png-fixture.ts';
import {
  beginAsset,
  assetInput,
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
test('the actual asset HTTP pipeline rejects corrupt PNG pixels behind an intact header and recovers with the original image', async () => {
  const target = await new ServerProcess().create();
  try {
    const client = await member(target),
      before = await library(client),
      bytes = await cube(),
      png = await readFile(
        new URL(
          '../../apps/web/public/lab-assets/hdr/studio-thumbnail.png',
          import.meta.url,
        ),
      ),
      bad = corruptPngPixelStream(png);
    assert.deepEqual(bad.subarray(0, 33), png.subarray(0, 33));
    const withImage = (image: Buffer) =>
      rewriteGlb(bytes, (root) => {
        root.images = [
          { uri: 'data:image/png;base64,' + image.toString('base64') },
        ];
      });
    const attempt = await beginAsset(
      client,
      withImage(bad),
      'Corrupt image stream',
    );
    await client.error(
      'POST',
      attempt.path,
      undefined,
      422,
      'files.upload_rejected',
    );
    assert.deepEqual(await library(client), before);
    const valid = withImage(png),
      recovered = await publishAsset(client, valid, 'Original PNG image');
    const signed = await client.json<DownloadCapability>(
        'GET',
        `/api/v1/lab/assets/${recovered.id}/download`,
      ),
      response = await fetch(signed.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), valid);
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
test('lower current upload policy refuses large start inputs while a persisted ready asset still completes and downloads exact bytes', async () => {
  const target = await new ServerProcess().create();
  try {
    const client = await member(target),
      bytes = await cube(),
      attempt = await beginAsset(client, bytes, 'Ready before policy change'),
      ready = await client.json<LabAsset>('POST', attempt.path);
    await target.stop();
    target.env.FILE_MAX_BYTES = String(bytes.length - 1);
    await target.start();
    await client.login('member@example.test');
    await client.error(
      'POST',
      '/api/v1/lab/asset-uploads',
      attempt.input,
      413,
      'files.too_large',
      attempt.headers,
    );
    await client.error(
      'POST',
      '/api/v1/lab/asset-uploads',
      assetInput(bytes, 'Fresh too-large input'),
      413,
      'files.too_large',
      { 'idempotency-key': 'new-policy-intent' },
    );
    assert.deepEqual(await client.json<LabAsset>('POST', attempt.path), ready);
    const signed = await client.json<DownloadCapability>(
        'GET',
        `/api/v1/lab/assets/${ready.id}/download`,
      ),
      response = await fetch(signed.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await library(client)).max_upload_bytes, bytes.length - 1);
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

test('two admitted validators never invoke a trapped native instance again; fresh initialization recovers both uploads', async () => {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/lab-native-trap.ts';
  target.ipc = true;
  async function message(command: string, stage: string) {
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      const receive = (value: unknown) => {
        if (
          value &&
          typeof value === 'object' &&
          'stage' in value &&
          value.stage === stage
        ) {
          target.child!.off('message', receive);
          resolve(value as Record<string, unknown>);
        }
      };
      target.child!.on('message', receive);
    });
    target.child!.send(command);
    return reply;
  }
  try {
    const client = await member(target),
      before = await library(client),
      bytes = await cube();
    const first = await beginAsset(client, bytes, 'First native validator'),
      second = await beginAsset(
        client,
        rewriteGlb(bytes, (root) => {
          root.asset = {
            ...(root.asset as Record<string, unknown>),
            generator: 'Distinct parallel bytes',
          };
        }),
        'Second native validator',
      );
    const outcomes = await Promise.allSettled([
      client.error('POST', first.path, undefined, 503, 'files.unavailable'),
      client.error('POST', second.path, undefined, 503, 'files.unavailable'),
    ]);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') throw outcome.reason;
    assert.deepEqual(await library(client), before);
    assert.equal(
      (await message('native-status', 'native-status')).unsafeCalls,
      0,
    );
    await message('restore-native', 'native-restored');
    const a = await client.json<LabAsset>('POST', first.path),
      b = await client.json<LabAsset>('POST', second.path);
    assert.equal(a.representation.file_id, first.upload.upload_id);
    assert.equal(b.representation.file_id, second.upload.upload_id);
    assert.equal((await library(client)).data.length, 2);
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

test('a missing Meshopt module keeps availability classification while cache cleanup and same-upload recovery run', async () => {
  const target = await new ServerProcess().create();
  target.entry = 'tests/support/lab-meshopt-fault.ts';
  target.ipc = true;
  try {
    const client = await member(target),
      before = await library(client),
      bytes = await readFile(
        new URL('../fixtures/lab/cube-meshopt.glb', import.meta.url),
      ),
      attempt = await beginAsset(client, bytes, 'Recoverable Meshopt');
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
