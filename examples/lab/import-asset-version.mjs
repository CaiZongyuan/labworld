import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const credential = process.env.LAB_API_KEY;
const input = process.argv[2];
const uploads = [];
const media = {
  glb: 'model/gltf-binary',
  usd: 'model/vnd.usd',
  urdf: 'application/xml',
  pdf: 'application/pdf',
  json: 'application/json',
};
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 204) return undefined;
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}: ${value.error?.code ?? 'request_failed'}`,
    );
  return value;
}
try {
  if (!credential || !input)
    throw new Error('Set LAB_API_KEY and pass an asset description path');
  const description = JSON.parse(await readFile(input, 'utf8'));
  const resources = [];
  for (const resource of description.resources) {
    if (!resource.file) {
      resources.push(resource);
      continue;
    }
    const path = resolve(dirname(input), resource.file),
      bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = await request('/api/v1/lab/asset-resource-uploads', 'POST', {
      file_name: basename(path),
      content_type: media[resource.format],
      size: bytes.length,
      sha256,
    });
    uploads.push(upload.upload_id);
    const put = await fetch(upload.upload.url, {
      method: 'PUT',
      headers: upload.upload.headers,
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
    if (put.status !== 204)
      throw new Error(`Object upload failed: HTTP ${put.status}`);
    await put.arrayBuffer();
    const file = await request(
      `/api/v1/lab/asset-resource-uploads/${upload.upload_id}/complete`,
      'POST',
    );
    resources.push({
      key: resource.key,
      format: resource.format,
      file_id: file.id,
      sha256: file.sha256,
      size: file.size,
    });
  }
  const version = await request('/api/v1/lab/asset-versions', 'POST', {
    ...description,
    resources,
  });
  const saved = await request(`/api/v1/lab/asset-versions/${version.id}`);
  console.log(
    JSON.stringify(
      {
        id: saved.id,
        asset_id: saved.asset_id,
        version: saved.version,
        content_sha256: saved.content_sha256,
        representations: saved.representations.map((entry) => entry.key),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof Error && /^(Set |HTTP |Object )/.test(error.message)
      ? error.message
      : 'Asset import did not finish; check the description and connection',
  );
  process.exitCode = 1;
} finally {
  for (const id of uploads) {
    try {
      await request(`/api/v1/lab/asset-resource-uploads/${id}`, 'DELETE');
    } catch {
      console.error(
        'An owned upload receipt needs cleanup; retry cancellation through the asset resource API',
      );
      process.exitCode = 1;
    }
  }
}
