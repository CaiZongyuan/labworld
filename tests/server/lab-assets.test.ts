import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  CreatedApiKey,
  CreateAssetUpload,
  UploadCapability,
  LabAsset,
  DownloadCapability,
  AssetPage,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

test('a real Member starts a persistent Lab GLB upload and safely retries the same intent', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const member = new CoreHttp(target.url);
    await member.register('member@example.test');
    assert.equal(member.session!.user.role, 'member');
    const key = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Asset Agent', scopes: ['lab:full'], expires_in_days: 1 },
      201,
    );
    assert.equal(key.key.user_id, member.session!.user.id);
    const bytes = await readFile(
      new URL('../fixtures/lab/cube.glb', import.meta.url),
    );
    const input: CreateAssetUpload = {
      name: 'Persistent bench',
      source: 'Contract geometry fixture',
      license: 'CC0',
      version: '1.0',
      file: {
        file_name: 'bench.glb',
        content_type: 'model/gltf-binary',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    const headers = { 'idempotency-key': randomUUID() };
    const upload = await member.json<UploadCapability>(
      'POST',
      '/api/v1/lab/asset-uploads',
      input,
      201,
      headers,
    );
    assert.equal(upload.state, 'pending_upload');
    assert.match(upload.upload_id, /^[0-9a-f-]{36}$/);
    assert.equal(upload.upload!.method, 'PUT');
    assert.deepEqual(
      await member.json<UploadCapability>(
        'POST',
        '/api/v1/lab/asset-uploads',
        input,
        201,
        headers,
      ),
      upload,
    );
    await member.error(
      'POST',
      '/api/v1/lab/asset-uploads',
      { ...input, name: 'Changed intent' },
      409,
      'idempotency.conflict',
      headers,
    );
    await target.stop();
    await target.start();
    await member.login('member@example.test');
    assert.deepEqual(
      await member.json<UploadCapability>(
        'POST',
        '/api/v1/lab/asset-uploads',
        input,
        201,
        headers,
      ),
      upload,
    );
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

test('the real asset library preserves metadata on invalid rename and removes unreferenced bytes safely', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('member@example.test');
    const before = await member.json<AssetPage>('GET', '/api/v1/lab/assets');
    assert.deepEqual(before.data, []);
    assert.equal(before.max_upload_bytes, 20 * 1024 * 1024);
    assert.equal(before.max_decoded_resource_bytes, 256 * 1024 * 1024);
    const bytes = await readFile(
      new URL('../fixtures/lab/cube.glb', import.meta.url),
    );
    const input: CreateAssetUpload = {
      name: 'Original name',
      source: 'Contract source',
      license: 'CC0',
      version: '1.0',
      file: {
        file_name: 'cube.glb',
        content_type: 'model/gltf-binary',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    const upload = await member.json<UploadCapability>(
      'POST',
      '/api/v1/lab/asset-uploads',
      input,
      201,
      { 'idempotency-key': randomUUID() },
    );
    const put = await fetch(upload.upload!.url, {
      method: 'PUT',
      headers: upload.upload!.headers,
      body: bytes,
    });
    assert.equal(put.status, 204);
    await put.arrayBuffer();
    const asset = await member.json<LabAsset>(
      'POST',
      `/api/v1/lab/asset-uploads/${upload.upload_id}/complete`,
    );
    const assetPath = `/api/v1/lab/assets/${asset.id}`;
    await member.error(
      'PATCH',
      assetPath,
      { name: '' },
      400,
      'lab.invalid_input',
    );
    assert.deepEqual(await member.json<LabAsset>('GET', assetPath), asset);
    const renamed = await member.json<LabAsset>('PATCH', assetPath, {
      name: 'Renamed',
    });
    assert.equal(renamed.name, 'Renamed');
    assert.deepEqual(renamed.representation, asset.representation);
    assert.deepEqual(
      (await member.json<AssetPage>('GET', '/api/v1/lab/assets?limit=1')).data,
      [renamed],
    );
    const download = await member.json<DownloadCapability>(
      'GET',
      assetPath + '/download',
    );
    await member.json('DELETE', assetPath, undefined, 204);
    await member.error('GET', assetPath, undefined, 404, 'lab.asset_not_found');
    assert.deepEqual(
      (await member.json<AssetPage>('GET', '/api/v1/lab/assets')).data,
      [],
    );
    const removed = await fetch(download.url);
    assert.equal(removed.status, 404);
    await removed.arrayBuffer();
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

test('a Member publishes immutable GLB bytes once; an Agent and reopened server read the same asset', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const member = new CoreHttp(target.url);
    await member.register('member@example.test');
    const key = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Asset Agent', scopes: ['lab:full'], expires_in_days: 1 },
      201,
    );
    const agent = new CoreHttp(target.url);
    const authorization = { authorization: `Bearer ${key.secret}` };
    const bytes = await readFile(
      new URL('../fixtures/lab/cube.glb', import.meta.url),
    );
    const input: CreateAssetUpload = {
      name: 'Persistent geometry',
      source: 'Fixture',
      license: 'CC0',
      version: '1.0',
      file: {
        file_name: 'cube.glb',
        content_type: 'model/gltf-binary',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    const headers = { 'idempotency-key': randomUUID() };
    const upload = await member.json<UploadCapability>(
      'POST',
      '/api/v1/lab/asset-uploads',
      input,
      201,
      headers,
    );
    const put = await fetch(upload.upload!.url, {
      method: 'PUT',
      headers: upload.upload!.headers,
      body: bytes,
    });
    assert.equal(put.status, 204);
    await put.arrayBuffer();
    const path = `/api/v1/lab/asset-uploads/${upload.upload_id}/complete`;
    const [asset, replay] = await Promise.all([
      member.json<LabAsset>('POST', path),
      agent.json<LabAsset>('POST', path, undefined, 200, authorization),
    ]);
    assert.deepEqual(replay, asset);
    assert.equal(
      new Set([asset.id, asset.representation.id, asset.representation.file_id])
        .size,
      3,
    );
    assert.equal(asset.created_by, member.session!.user.id);
    assert.equal(asset.representation.file_id, upload.upload_id);
    assert.deepEqual(
      await member.json<UploadCapability>(
        'POST',
        '/api/v1/lab/asset-uploads',
        input,
        201,
        headers,
      ),
      { upload_id: upload.upload_id, state: 'ready', upload: null },
    );
    const downloaded = await agent.json<DownloadCapability>(
      'GET',
      `/api/v1/lab/assets/${asset.id}/download`,
      undefined,
      200,
      authorization,
    );
    const get = await fetch(downloaded.url);
    assert.equal(get.status, 200);
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
    await target.stop();
    await target.start();
    await member.login('member@example.test');
    assert.deepEqual(
      await member.json<LabAsset>('GET', `/api/v1/lab/assets/${asset.id}`),
      asset,
    );
    const reopened = await member.json<DownloadCapability>(
      'GET',
      `/api/v1/lab/assets/${asset.id}/download`,
    );
    assert.deepEqual(
      Buffer.from(await (await fetch(reopened.url)).arrayBuffer()),
      bytes,
    );
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
