import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '../../apps/server/src/config.ts';
import { transportLog } from '../../apps/server/src/transport.ts';
import { parseMotionHello } from '../../packages/contracts/src/motion/index.ts';
import {
  assertPrivateDenial,
  denialEvidence,
} from '../e2e/secure-motion-oracle.ts';
import { assertSourceWitness } from '../e2e/secure-source-witness.ts';
import {
  frameBatch,
  sourcePacket,
  type RecordingIdentity,
  type RecordingRecord,
} from '../e2e/recording-wire-oracle.ts';

test('incomplete Recording witness rejects lost confirmed packets and accepts only an exact retained prefix', () => {
  const directory = mkdtempSync(join(tmpdir(), 'secure-source-witness-'));
  const previous = process.env.SECURE_MOTION_SOURCE_WITNESS;
  process.env.SECURE_MOTION_SOURCE_WITNESS = directory;
  const identity: RecordingIdentity = {
    recording_id: '10000000-0000-0000-0000-000000000001',
    session_id: '10000000-0000-0000-0000-000000000002',
    lease_id: '10000000-0000-0000-0000-000000000003',
    epoch: '1',
    snapshot_hash: 'sha256:' + 'a'.repeat(64),
    manifest_sha256: 'sha256:' + 'b'.repeat(64),
    scene_hash: 'sha256:' + 'c'.repeat(64),
    mapping_revision: 1,
    mapping_sha256: 'sha256:' + 'd'.repeat(64),
  };
  const frames = [1n, 2n, 3n].map((sequence) => {
    const frame = Buffer.alloc(632);
    frame.write('LWM1');
    frame.writeBigUInt64LE(sequence, 16);
    return frame;
  });
  const packets = frames.map(
    (frame, index) =>
      sourcePacket(identity, 1, BigInt(index + 1), frameBatch([frame])).bytes,
  );
  const records = packets.map((packet, index): RecordingRecord => ({
    ordinal: String(index + 1),
    kind: 'source.packet',
    recorded_at: '2026-10-11T00:00:00Z',
    data: { packet_base64: packet.toString('base64') },
  }));
  function writeSpool(suffix: string, rows: Buffer[]) {
    writeFileSync(
      join(directory, identity.session_id + '.' + suffix),
      Buffer.concat(
        rows.flatMap((row) => {
          const length = Buffer.alloc(4);
          length.writeUInt32LE(row.length);
          return [length, row];
        }),
      ),
    );
  }
  try {
    writeSpool('frames', frames);
    writeSpool('packets', packets);
    const confirmed = packets.slice(0, 2);
    for (const truncated of [[], records.slice(0, 1)])
      assert.throws(() =>
        assertSourceWitness(identity.session_id, truncated, false, confirmed),
      );
    assert.throws(() =>
      assertSourceWitness(identity.session_id, records, false),
    );
    assert.throws(() =>
      assertSourceWitness(identity.session_id, records, false, []),
    );
    const retained = assertSourceWitness(
      identity.session_id,
      records.slice(0, 2),
      false,
      confirmed,
    );
    assert.equal(retained.confirmedPackets, 2);
    assert.equal(retained.retainedPackets, 2);
    assert.equal(retained.unconfirmedSelectedTail, 1);
    assert.equal(
      assertSourceWitness(identity.session_id, records, false, confirmed)
        .retainedPackets,
      3,
    );
    assertSourceWitness(identity.session_id, records, true);
    const changed = Buffer.from(confirmed[0]);
    changed[changed.length - 1] ^= 1;
    assert.throws(() =>
      assertSourceWitness(identity.session_id, records, false, [
        changed,
        confirmed[1],
      ]),
    );
  } finally {
    if (previous === undefined) delete process.env.SECURE_MOTION_SOURCE_WITNESS;
    else process.env.SECURE_MOTION_SOURCE_WITNESS = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

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
