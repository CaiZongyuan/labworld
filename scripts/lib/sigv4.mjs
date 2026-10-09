import { createHash, createHmac } from 'node:crypto';

// Minimal AWS Signature Version 4 for the backup/restore tooling. The
// production entrance (caddy) forwards bucket paths and the Host header to
// the object store unchanged, so requests signed against the public origin
// are accepted exactly like presigned URLs.

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

export function signRequest({
  method,
  url,
  headers = {},
  body = undefined,
  accessKeyId,
  secretAccessKey,
  region,
  service,
  amzDate = headers['x-amz-date'],
}) {
  const target = new URL(url);
  const payloadHash = headers['x-amz-content-sha256'] ?? sha256Hex(body ?? '');
  const signedHeadersMap = {
    host: target.host,
    'x-amz-date': amzDate,
    ...(headers['x-amz-content-sha256']
      ? { 'x-amz-content-sha256': payloadHash }
      : {}),
    ...Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => name !== 'host' && name !== 'x-amz-date',
      ),
    ),
  };
  const signedHeaders = Object.keys(signedHeadersMap).sort().join(';');
  const canonicalHeaders = Object.keys(signedHeadersMap)
    .sort()
    .map((name) => `${name}:${signedHeadersMap[name].trim()}\n`)
    .join('');
  const canonicalRequest = [
    method,
    canonicalUri(target),
    canonicalQuery(target),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${secretAccessKey}`, amzDate.slice(0, 8)), region),
      service,
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  return {
    headers: {
      ...signedHeadersMap,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
    },
  };
}

export function amzDateNow() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function canonicalUri(target) {
  return target.pathname
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

function canonicalQuery(target) {
  const entries = [...target.searchParams.entries()].map(([name, value]) => [
    encodeRfc3986(name),
    encodeRfc3986(value),
  ]);
  entries.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1,
  );
  return entries.map(([name, value]) => `${name}=${value}`).join('&');
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
