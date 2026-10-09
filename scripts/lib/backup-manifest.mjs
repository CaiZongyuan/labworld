// Manifest and report logic for the production backup/restore tooling. Pure
// functions: the docker-driven scripts feed data in, tests pin behavior
// without a Docker daemon.

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function buildManifest({
  createdAt,
  image,
  imageDigest,
  dumpFile,
  migrationVersion,
  migrationCount,
  objects,
}) {
  for (const [field, value] of [
    ['createdAt', createdAt],
    ['image', image],
    ['imageDigest', imageDigest],
    ['dumpFile', dumpFile],
  ]) {
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`manifest requires ${field}`);
  }
  if (!Number.isInteger(migrationVersion) || migrationVersion < 1)
    throw new Error('manifest requires a positive migrationVersion');
  if (!Number.isInteger(migrationCount) || migrationCount < 1)
    throw new Error('manifest requires a positive migrationCount');
  const entries = objects.map((object) => normalizeObject(object));
  return {
    schema_version: 1,
    created_at: createdAt,
    application: { image, image_digest: imageDigest },
    database: {
      dump_file: dumpFile,
      dump_format: 'pg_custom',
      migration_version: migrationVersion,
      migration_count: migrationCount,
    },
    objects: { count: entries.length, entries },
  };
}

function normalizeObject({ file_id, bucket, object_key, sha256, size_bytes }) {
  if (typeof file_id !== 'string' || file_id.length === 0)
    throw new Error('manifest object requires file_id');
  if (typeof bucket !== 'string' || bucket.length === 0)
    throw new Error('manifest object requires bucket');
  if (typeof object_key !== 'string' || object_key.length === 0)
    throw new Error('manifest object requires object_key');
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256))
    throw new Error('manifest object requires a 32-byte hex sha256');
  if (!Number.isInteger(size_bytes) || size_bytes < 0)
    throw new Error('manifest object requires a non-negative size_bytes');
  return { file_id, bucket, object_key, sha256, size_bytes };
}

// Compares the manifest against a live bucket listing. Extra objects (for
// example abandoned staging keys) are surfaced but never break consistency:
// only the database-referenced ready objects must match.
export function verifyObjects(manifest, liveEntries) {
  const live = new Map(liveEntries.map((entry) => [entry.key, entry.size]));
  const missing = [];
  const sizeMismatch = [];
  for (const object of manifest.objects.entries) {
    if (!live.has(object.object_key)) {
      missing.push(object.object_key);
    } else if (live.get(object.object_key) !== object.size_bytes) {
      sizeMismatch.push({
        object_key: object.object_key,
        expected: object.size_bytes,
        actual: live.get(object.object_key),
      });
    }
  }
  const referenced = new Set(
    manifest.objects.entries.map((object) => object.object_key),
  );
  const extra = liveEntries
    .map((entry) => entry.key)
    .filter((key) => !referenced.has(key));
  return {
    missing,
    size_mismatch: sizeMismatch,
    extra,
    consistent: missing.length === 0 && sizeMismatch.length === 0,
  };
}

// A reviewable markdown report. It carries identifiers, counts and check
// details, never document or object content: the drill compares content by
// digest and records only the verdict.
export function renderReport({
  kind,
  createdAt,
  archive,
  manifest,
  verification,
  checks,
}) {
  const failed = checks.filter((check) => check.status !== 'pass');
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  const lines = [
    `# ${kind === 'restore' ? '恢复' : '备份'}报告：${verdict}`,
    '',
    `- 归档：${archive}`,
    `- 创建时间：${createdAt}`,
    `- 应用镜像：${manifest.application.image} (${manifest.application.image_digest.slice(0, 18)}…)`,
    `- 迁移版本：${manifest.database.migration_version}（${manifest.database.migration_count} 个已应用）`,
    `- ready 对象：${manifest.objects.count} 个`,
  ];
  if (verification) {
    lines.push(
      `- 清单核对：${verification.consistent ? '一致' : '不一致'}` +
        (verification.missing.length
          ? `，缺失 ${verification.missing.length}`
          : '') +
        (verification.extra.length
          ? `，未引用对象 ${verification.extra.length} 个`
          : ''),
    );
  }
  lines.push('', '| 检查 | 结果 | 说明 |', '| --- | --- | --- |');
  for (const check of checks) {
    lines.push(
      `| ${check.name} | ${check.status === 'pass' ? '通过' : '失败'} | ${check.detail ?? ''} |`,
    );
  }
  return lines.join('\n') + '\n';
}
