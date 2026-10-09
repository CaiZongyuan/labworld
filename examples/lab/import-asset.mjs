import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const api = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const credential = process.env.LAB_API_KEY;
const path = process.argv[2];

async function request(route, method = 'GET', body, headers = {}) {
  const response = await fetch(new URL(route, api), {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}: ${result.error?.code ?? 'request_failed'}`,
    );
  return result;
}

async function importAsset() {
  if (!credential || !path)
    throw new Error('Set LAB_API_KEY and pass a GLB path');
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileName = basename(path);
  const upload = await request(
    '/api/v1/lab/asset-uploads',
    'POST',
    {
      name: process.env.LAB_ASSET_NAME ?? fileName.replace(/\.glb$/i, ''),
      source: process.env.LAB_ASSET_SOURCE ?? '',
      license: process.env.LAB_ASSET_LICENSE ?? '',
      version: process.env.LAB_ASSET_VERSION ?? '1.0',
      file: {
        file_name: fileName,
        content_type: 'model/gltf-binary',
        size: bytes.length,
        sha256,
      },
    },
    { 'idempotency-key': process.env.LAB_UPLOAD_KEY ?? randomUUID() },
  );
  if (upload.upload) {
    const response = await fetch(upload.upload.url, {
      method: upload.upload.method,
      headers: upload.upload.headers,
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`Object upload failed: HTTP ${response.status}`);
  }
  const asset = await request(
    `/api/v1/lab/asset-uploads/${upload.upload_id}/complete`,
    'POST',
  );
  const saved = await request(`/api/v1/lab/assets/${asset.id}`);
  const capability = await request(`/api/v1/lab/assets/${asset.id}/download`);
  const response = await fetch(capability.url, {
    headers: capability.headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`Object download failed: HTTP ${response.status}`);
  const recovered = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(recovered).digest('hex') !== sha256)
    throw new Error('Recovered bytes do not match the imported GLB');
  console.log(
    JSON.stringify(
      {
        id: saved.id,
        name: saved.name,
        representation_id: saved.representation.id,
        file_id: saved.representation.file_id,
        size: recovered.length,
        sha256,
      },
      null,
      2,
    ),
  );
}

try {
  await importAsset();
} catch (error) {
  // Transport errors may contain signed URLs; only explicit workflow errors are printable.
  console.error(
    error instanceof Error &&
      /^(Set |HTTP |Object |Recovered )/.test(error.message)
      ? error.message
      : 'Import did not finish; check connectivity and retry with the same LAB_UPLOAD_KEY',
  );
  process.exitCode = 1;
}
