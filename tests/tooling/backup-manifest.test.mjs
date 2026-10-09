import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifest,
  verifyObjects,
  renderReport,
} from '../../scripts/lib/backup-manifest.mjs';

const readyObject = {
  file_id: '0b6a0e6e-9c0a-4c31-9a63-1a5a5d56b100',
  bucket: 'labos-files',
  object_key: 'ready/0b6a0e6e',
  sha256: 'a'.repeat(64),
  size_bytes: 128,
};

test('builds a normalized manifest and rejects incomplete objects', () => {
  const manifest = buildManifest({
    createdAt: '2026-09-27T00:00:00.000Z',
    image: 'labos-threejs-production:local',
    imageDigest: 'sha256:' + 'b'.repeat(64),
    dumpFile: 'database.dump',
    migrationVersion: 17,
    migrationCount: 17,
    objects: [readyObject],
  });
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.database.migration_version, 17);
  assert.equal(manifest.objects.count, 1);
  assert.deepEqual(manifest.objects.entries[0], readyObject);
  assert.throws(
    () =>
      buildManifest({
        createdAt: '2026-09-27T00:00:00.000Z',
        image: 'i',
        imageDigest: 'sha256:' + 'b'.repeat(64),
        dumpFile: 'database.dump',
        migrationVersion: 17,
        migrationCount: 17,
        objects: [{ ...readyObject, sha256: 'not-hex' }],
      }),
    /sha256/,
  );
  assert.throws(
    () =>
      buildManifest({
        createdAt: '2026-09-27T00:00:00.000Z',
        image: 'i',
        imageDigest: 'sha256:' + 'b'.repeat(64),
        dumpFile: 'database.dump',
        migrationVersion: 17,
        migrationCount: 17,
        objects: [{ ...readyObject, size_bytes: -1 }],
      }),
    /size_bytes/,
  );
});

test('verification passes when every ready object is present with its size', () => {
  const manifest = minimalManifest([readyObject]);
  const verification = verifyObjects(manifest, [
    { key: 'ready/0b6a0e6e', size: 128 },
  ]);
  assert.deepEqual(verification.missing, []);
  assert.deepEqual(verification.size_mismatch, []);
  assert.equal(verification.consistent, true);
});

test('verification reports missing and mismatched objects and surfaces extras', () => {
  const manifest = minimalManifest([
    readyObject,
    {
      file_id: '0b6a0e6e-9c0a-4c31-9a63-1a5a5d56b200',
      bucket: 'labos-files',
      object_key: 'ready/other',
      sha256: 'c'.repeat(64),
      size_bytes: 10,
    },
  ]);
  const verification = verifyObjects(manifest, [
    { key: 'ready/0b6a0e6e', size: 999 },
    { key: 'staging/leftover', size: 1 },
  ]);
  assert.deepEqual(verification.missing, ['ready/other']);
  assert.deepEqual(verification.size_mismatch, [
    { object_key: 'ready/0b6a0e6e', expected: 128, actual: 999 },
  ]);
  assert.deepEqual(verification.extra, ['staging/leftover']);
  assert.equal(verification.consistent, false);
});

test('renders a verdict-carrying report without object content', () => {
  const report = renderReport({
    kind: 'restore',
    createdAt: '2026-09-27T00:00:00.000Z',
    archive: '/tmp/archive',
    manifest: minimalManifest([readyObject]),
    verification: verifyObjects(minimalManifest([readyObject]), [
      { key: 'ready/0b6a0e6e', size: 128 },
    ]),
    checks: [
      { name: '数据库恢复', status: 'pass', detail: 'migration 17' },
      {
        name: '对象传输',
        status: 'fail',
        detail: 'ready/0b6a0e6e 缺失',
      },
    ],
  });
  assert.match(report, /恢复报告/);
  assert.match(report, /FAIL/);
  assert.match(report, /数据库恢复/);
  assert.match(report, /ready\/0b6a0e6e 缺失/);
  // A report reviews metadata, never document or object content.
  assert.ok(!report.includes('a'.repeat(64)), 'digests stay out of the report');
  const passing = renderReport({
    kind: 'restore',
    createdAt: '2026-09-27T00:00:00.000Z',
    archive: '/tmp/archive',
    manifest: minimalManifest([readyObject]),
    verification: verifyObjects(minimalManifest([readyObject]), [
      { key: 'ready/0b6a0e6e', size: 128 },
    ]),
    checks: [{ name: '数据库恢复', status: 'pass', detail: 'ok' }],
  });
  assert.match(passing, /PASS/);
  assert.ok(
    !passing.includes('FAIL'),
    'a passing report carries no fail verdict',
  );
});

function minimalManifest(objects) {
  return buildManifest({
    createdAt: '2026-09-27T00:00:00.000Z',
    image: 'labos-threejs-production:local',
    imageDigest: 'sha256:' + 'b'.repeat(64),
    dumpFile: 'database.dump',
    migrationVersion: 17,
    migrationCount: 17,
    objects,
  });
}
