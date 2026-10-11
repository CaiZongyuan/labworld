import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuration } from '../../apps/server/src/config.ts';
import { transportLog } from '../../apps/server/src/transport.ts';
import { parseMotionHello } from '../../packages/contracts/src/motion/index.ts';
import {
  assertPrivateDenial,
  denialEvidence,
} from '../e2e/secure-motion-oracle.ts';

test('denial oracle accepts a public refusal and rejects error-wrapped private mapping and frame leakage', () => {
  const error = {
    type: 'motion.error',
    code: 'unauthorized',
    message: 'Motion admission failed',
  };
  assert.equal(
    assertPrivateDenial(0, [error], 'unauthorized').metadataMessages,
    0,
  );
  const disguised = {
    ...error,
    pose_keys: ['private-body'],
    targets: [{ entity_id: 'private-entity' }],
  };
  assert.equal(denialEvidence(0, [disguised]).metadataMessages, 1);
  assert.throws(() => assertPrivateDenial(0, [disguised]));
  assert.throws(() =>
    assertPrivateDenial(0, [
      { ...error, message: 'private coordinates: 1,2,3' },
    ]),
  );
  assert.throws(() => assertPrivateDenial(632, [error]));
  assert.throws(() => assertPrivateDenial(0, [error], 'private scene details'));
});

test('TLS is explicit and paired, while plaintext Synthetic and fixtures remain loopback only', () => {
  assert.equal(configuration({}).tls, undefined);
  assert.equal(
    configuration({
      LAB_WORD_SYNTHETIC_SESSION: 'true',
      LAB_WORD_SYNTHETIC_MANAGED: '',
    }).managedSynthetic,
    true,
  );
  assert.throws(() => configuration({ LAB_WORD_TLS_CERT: 'cert.pem' }));
  assert.throws(() => configuration({ LAB_WORD_TLS_KEY: 'key.pem' }));
  assert.throws(() =>
    configuration({
      LAB_WORD_TLS_CERT: 'cert.pem',
      LAB_WORD_TLS_KEY: 'key.pem',
    }),
  );
  assert.throws(() =>
    configuration({
      LAB_WORD_HOST: '0.0.0.0',
      LAB_WORD_SYNTHETIC_SESSION: 'true',
    }),
  );
  const remote = {
    APP_ORIGIN: 'https://lab.example.test',
    LAB_WORD_HOST: '0.0.0.0',
    LAB_WORD_SYNTHETIC_SESSION: 'true',
    LAB_WORD_SYNTHETIC_MANAGED: 'false',
    LAB_WORD_TLS_CERT: 'cert.pem',
    LAB_WORD_TLS_KEY: 'key.pem',
  };
  assert.equal(configuration(remote).managedSynthetic, false);
  assert(configuration(remote).tls);
  assert.throws(() =>
    configuration({ ...remote, LAB_WORD_MOTION_FIXTURE: 'true' }),
  );
});

test('Viewer expected scene is validated as a wire hash, while retained fixture HELLO stays compatible', () => {
  const hello = {
    type: 'motion.hello',
    version: 1,
    codec: 'pose-f32-v1',
    role: 'viewer',
    session_id: '10000000-0000-0000-0000-000000000001',
    ticket: 'scoped_ticket_123456789',
    preferred_rate_hz: 30,
  };
  assert.equal(parseMotionHello(JSON.stringify(hello)).scene_hash, undefined);
  assert.equal(
    parseMotionHello(
      JSON.stringify({ ...hello, scene_hash: 'sha256:' + 'a'.repeat(64) }),
    ).scene_hash,
    'sha256:' + 'a'.repeat(64),
  );
  assert.throws(() =>
    parseMotionHello(
      JSON.stringify({ ...hello, scene_hash: 'private mapping text' }),
    ),
  );
});

test('ordinary admission and HTTP path logs omit private scope and arbitrary exception text', () => {
  const id = '10000000-0000-0000-0000-000000000001';
  assert.deepEqual(
    transportLog({
      event: 'motion.admission_failed',
      session_id: id,
      ticket: 'private-ticket',
      reason: 'untrusted server text',
      code: 'unauthorized',
    }),
    { event: 'motion.admission_failed', code: 'unauthorized' },
  );
  const entry = transportLog({
    event: 'http.request',
    path: `/api/v1/lab/labs/${id}/sessions/${id}/viewer-tickets`,
    status: 201,
  });
  assert.equal(entry.path, '/api/v1/lab/labs/:id/sessions/:id/viewer-tickets');
});
