import test from 'node:test';
import assert from 'node:assert/strict';
import { signRequest } from '../../scripts/lib/sigv4.mjs';

// The signing vector is AWS's published "get-vanilla" example from the
// official SigV4 test suite; it pins the canonical request, the string to
// sign and the derived key exactly.
test('signs the AWS get-vanilla vector byte for byte', () => {
  const { headers: signed } = signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: { 'x-amz-date': '20150830T123600Z' },
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
  });
  assert.equal(
    signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('signs S3 requests with the payload hash header included', () => {
  const { headers } = signRequest({
    method: 'GET',
    url: 'https://localhost/labos-files?list-type=2&prefix=ready/',
    headers: {
      'x-amz-date': '20260927T000000Z',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
  });
  // The signed header list must be lowercased and sorted, and the payload
  // hash must be part of it because S3 requires the header.
  const signed = authorizationSignedHeaders(headers.authorization);
  assert.equal(signed, 'host;x-amz-content-sha256;x-amz-date');
  // Signing is deterministic for identical input.
  const again = signRequest({
    method: 'GET',
    url: 'https://localhost/labos-files?list-type=2&prefix=ready/',
    headers: {
      'x-amz-date': '20260927T000000Z',
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
  });
  assert.equal(headers.authorization, again.headers.authorization);
});

function authorizationSignedHeaders(authorization) {
  return /SignedHeaders=([^,]+)/.exec(authorization)[1];
}
