import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CreateAssetUpload,
  LabAsset,
  UploadCapability,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { CoreHttp } from './core-http.ts';
export function assetInput(
  bytes: Buffer,
  name = 'Verified fixture',
): CreateAssetUpload {
  return {
    name,
    source: 'Contract geometry fixture',
    license: 'CC0',
    version: '1.0',
    file: {
      file_name: 'contract.glb',
      content_type: 'model/gltf-binary',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
export async function beginAsset(
  client: CoreHttp,
  bytes: Buffer,
  name = 'Verified fixture',
  key = randomUUID(),
) {
  const input = assetInput(bytes, name),
    headers = { 'idempotency-key': key };
  const upload = await client.json<UploadCapability>(
    'POST',
    '/api/v1/lab/asset-uploads',
    input,
    201,
    headers,
  );
  const put = await fetch(upload.upload!.url, {
    method: 'PUT',
    headers: upload.upload!.headers,
    body: new Uint8Array(bytes),
  });
  assert.equal(put.status, 204);
  await put.arrayBuffer();
  return {
    input,
    headers,
    upload,
    path: `/api/v1/lab/asset-uploads/${upload.upload_id}/complete`,
  };
}
export async function publishAsset(
  client: CoreHttp,
  bytes: Buffer,
  name = 'Verified fixture',
) {
  const attempt = await beginAsset(client, bytes, name);
  return client.json<LabAsset>('POST', attempt.path);
}
export function rewriteGlb(
  bytes: Buffer,
  change: (root: Record<string, unknown>) => void,
) {
  const length = bytes.readUInt32LE(12),
    root = JSON.parse(
      bytes.subarray(20, 20 + length).toString('utf8'),
    ) as Record<string, unknown>;
  change(root);
  const json = Buffer.from(JSON.stringify(root)),
    padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const tail = bytes.subarray(20 + length),
    header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + padded.length + tail.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, tail]);
}
