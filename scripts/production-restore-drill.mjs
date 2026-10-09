#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync, strFromU8 } from 'fflate';
import {
  drainLogPresent,
  listObjects,
  migrationState,
  originRootCa,
  psql,
  readEnvFile,
  request,
  runCompose,
  stopWithBudget,
} from './lib/production-stack.mjs';
import { renderReport, verifyObjects } from './lib/backup-manifest.mjs';
import { root } from './lib/process.mjs';

// The automatic restore drill, run against the single-machine production
// composition: seed a real journey, take a maintenance-window backup with
// the operator command, rebuild an independent empty environment with the
// operator restore command, and verify accounts, documents, attachments,
// queued jobs, pending-upload expiry and idempotent cleanup. The drill
// report lands in the archive; secrets never do — the environment file
// stays outside it and both projects are torn down afterwards.

const production = `labos-threejs-prod-drill-${process.pid}`;
const restore = `labos-threejs-prod-restore-${process.pid}`;
const scratch = join(root, '.scratch', `restore-drill-${process.pid}`);
const archive = join(scratch, 'archive');
const envPath = join(scratch, 'env.production');
const image = 'labos-threejs-production:local';
const password = randomBytes(18).toString('base64url');

mkdirSync(scratch, { recursive: true });
writeFileSync(
  envPath,
  [
    'DOMAIN=localhost',
    `POSTGRES_PASSWORD=${password}`,
    'APP_ORIGIN=https://localhost',
    `DATABASE_URL=postgres://labos_threejs:${password}@postgres:5432/labos_threejs`,
    'REDIS_URL=redis://redis:6379/',
    'S3_ENDPOINT=http://rustfs:9000',
    'S3_PUBLIC_ENDPOINT=https://localhost',
    'S3_BUCKET=labos-files',
    'S3_REGION=us-east-1',
    `S3_ACCESS_KEY=${randomBytes(18).toString('base64url')}`,
    `S3_SECRET_KEY=${randomBytes(24).toString('base64url')}`,
    // Configured but unreachable: the journey doubles as the degradation
    // proof while the backup window runs.
    'MAIL_SMTP_HOST=127.0.0.1',
    'MAIL_SMTP_PORT=1025',
    `MAIL_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    'TELEMETRY_ENDPOINT=http://127.0.0.1:4317',
    '',
  ].join('\n'),
);

const env = readEnvFile(envPath);
const base = env.APP_ORIGIN;
let rootCa;
let cookie;
let csrf;

async function application(path, method = 'GET', body) {
  const response = await request(method, `${base}${path}`, {
    headers: {
      origin: base,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    rootCa,
  });
  const parsed =
    response.status === 204
      ? undefined
      : JSON.parse(response.buffer.toString());
  const setCookie = response.headers['set-cookie'];
  if (setCookie?.length) {
    cookie = setCookie[0].split(';')[0];
    csrf = parsed?.csrf_token;
  }
  return { status: response.status, body: parsed };
}

class DrillFailure extends Error {}
function ensure(value, message) {
  if (!value) throw new DrillFailure(message);
}
async function eventually(action, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw new DrillFailure(
    `Timed out: ${label}${last ? ` (${last.message})` : ''}`,
  );
}

let stage = 'setup';
try {
  stage = 'image build';
  execFileSync(
    'docker',
    [
      'build',
      '-f',
      join(root, 'deploy/production/Dockerfile'),
      '-t',
      image,
      root,
    ],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );

  stage = 'production stack up';
  runCompose(production, envPath, [
    'up',
    '-d',
    '--wait',
    'postgres',
    'redis',
    'rustfs',
  ]);
  runCompose(production, envPath, ['run', '--rm', 'migrate'], 'ops');
  runCompose(production, envPath, ['run', '--rm', 'storage-init'], 'ops');
  runCompose(production, envPath, [
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '180',
    'api',
    'worker',
    'caddy',
  ]);

  stage = 'entrance';
  rootCa = originRootCa(production, envPath, base, scratch);
  ensure(
    (await request('GET', `${base}/health/live`, { rootCa })).status === 200,
    'health must pass the real TLS chain',
  );

  stage = 'seed';
  const secret = `drill-private-${randomUUID()}`;
  const attachmentBytes = Buffer.from(`attachment-${randomUUID()}`);
  const email = `drill-${randomBytes(6).toString('hex')}@example.test`;
  const registered = await application('/api/v1/auth/register', 'POST', {
    email,
    password: secret,
  });
  ensure(
    registered.status === 201 && registered.body.user.role === 'owner',
    `registration must initialize the organization (${registered.status})`,
  );
  const document = (
    await application('/api/v1/knowledge/documents', 'POST', {
      title: 'Restore drill',
      markdown: secret,
    })
  ).body;
  const documentPath = `/api/v1/knowledge/documents/${document.id}`;
  const upload = (
    await application(`${documentPath}/uploads`, 'POST', {
      file_name: 'notes.txt',
      content_type: 'text/plain',
      size: attachmentBytes.length,
      sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
    })
  ).body;
  // The transfer uses the application's own presigned URL through the
  // entrance, exactly like a browser would; the backup/restore signing only
  // covers archive operations.
  const transferred = await request('PUT', upload.upload.url, {
    headers: upload.upload.headers,
    body: attachmentBytes,
    rootCa,
  });
  ensure(
    transferred.status >= 200 && transferred.status < 300,
    `attachment transfer failed (${transferred.status})`,
  );
  await application(
    `${documentPath}/uploads/${upload.upload_id}/complete`,
    'POST',
    {},
  );
  // The pending victim: a session that never transfers its bytes. Its
  // staging object may or may not exist at snapshot time — the restore must
  // not care, which is exactly the idempotency the drill verifies.
  const pending = (
    await application(`${documentPath}/uploads`, 'POST', {
      file_name: 'never-finished.txt',
      content_type: 'text/plain',
      size: 4,
      sha256: 'a'.repeat(64),
    })
  ).body;
  ensure(Boolean(pending.upload_id), 'the pending upload session must exist');

  stage = 'window: worker drain';
  stopWithBudget(production, envPath, 'worker', 40);
  ensure(
    drainLogPresent(production, envPath, 'worker'),
    'the worker must exercise its claim-drain path',
  );

  stage = 'window: queue export';
  const exported = await application(`${documentPath}/exports`, 'POST', {});
  ensure(
    exported.status === 202 && exported.body.id,
    'the export must queue while the worker is down',
  );

  stage = 'backup';
  // The operator command takes it from here: it stops api on its drain
  // budget, sees the worker already drained, snapshots and verifies.
  execFileSync(
    'node',
    [
      join(root, 'scripts/production-backup.mjs'),
      '--project',
      production,
      '--env-file',
      envPath,
      '--archive',
      archive,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const manifest = JSON.parse(
    readFileSync(join(archive, 'manifest.json'), 'utf8'),
  );
  ensure(
    manifest.objects.entries.length >= 1,
    'the archive must contain the attachment',
  );

  stage = 'restore environment';
  runCompose(production, envPath, [
    'down',
    '-v',
    '--remove-orphans',
    '--timeout',
    '60',
  ]);
  execFileSync(
    'node',
    [
      join(root, 'scripts/production-restore.mjs'),
      '--project',
      restore,
      '--env-file',
      envPath,
      '--archive',
      archive,
      '--report',
      join(archive, 'restore-report.md'),
    ],
    { cwd: root, stdio: 'inherit' },
  );

  stage = 'verify restore';
  rootCa = originRootCa(restore, envPath, base, scratch);

  // The seeded session cookie survives the restore: account, document and
  // attachment are read back and compared byte for byte.
  const reread = await application(documentPath, 'GET');
  ensure(
    reread.status === 200 && reread.body.markdown === secret,
    'the restored account must read its document',
  );
  const attachments = (await application(`${documentPath}/attachments`, 'GET'))
    .body;
  const attachmentEntry = JSON.stringify(attachments);
  ensure(
    attachmentEntry.includes('notes.txt'),
    'the restored attachment must be listed',
  );
  ensure(
    !attachmentEntry.includes('never-finished.txt'),
    'the pending upload must not surface as an attachment',
  );
  const attachmentFileId = manifest.objects.entries[0].file_id;
  const download = (
    await application(
      `${documentPath}/attachments/${attachmentFileId}/download`,
      'GET',
    )
  ).body;
  const attachmentContent = await request('GET', download.url, { rootCa });
  ensure(
    attachmentContent.buffer.equals(attachmentBytes),
    'the restored attachment bytes must match the original',
  );
  const exportResult = await eventually(async () => {
    const result = await application(
      `${documentPath}/exports/${exported.body.id}`,
      'GET',
    );
    return result.body.status === 'succeeded' ? result.body : undefined;
  }, 'the restored queue must finish the exported job');
  const archiveLink = (
    await application(
      `${documentPath}/exports/${exportResult.id}/download`,
      'GET',
    )
  ).body;
  const zip = await request('GET', archiveLink.url, { rootCa });
  ensure(
    strFromU8(unzipSync(new Uint8Array(zip.buffer))['document.md']) === secret,
    'the exported markdown must survive the restore',
  );

  // Pending-upload expiry and idempotent missing-object cleanup: the
  // maintenance sweep expires the session and enqueues the cleanup job,
  // which attempts the (missing) staging object and records the deletion
  // idempotently. `expired` is the terminal state for this path — only
  // files removed through the API pass through `deleting`/`deleted`.
  const pendingId = pending.upload_id;
  // The upload TTL is 15 minutes by policy. The drill time-travels the
  // restored row's expiry so the drill stays short; the expiry transition,
  // cleanup enqueue and idempotent object deletion are still performed by
  // the real sweep and cleanup job.
  psql(
    restore,
    envPath,
    `UPDATE labos_threejs_core.files SET expires_at = clock_timestamp() - interval '1 second' WHERE id = '${pendingId}' AND state = 'pending_upload'`,
  );
  await eventually(
    async () => {
      const row = psql(
        restore,
        envPath,
        `SELECT f.state, g.first_deleted_at IS NOT NULL AND g.last_error IS NULL FROM labos_threejs_core.files f LEFT JOIN labos_threejs_core.object_cleanup g ON g.file_id = f.id WHERE f.id = '${pendingId}'`,
      );
      return row === 'expired|t' ? row : undefined;
    },
    'the pending upload must expire and its idempotent cleanup must be recorded',
    180_000,
  );
  const failedJobs = psql(
    restore,
    envPath,
    "SELECT count(*) FROM labos_threejs_core.jobs WHERE status = 'failed'",
  );
  ensure(failedJobs === '0', `no job may end failed, got ${failedJobs}`);

  stage = 'drill report';
  const { version: migrationVersion, count: migrationCount } = migrationState(
    restore,
    envPath,
  );
  const restoreVerification = verifyObjects(
    manifest,
    await listObjects(env, rootCa),
  );
  const report = renderReport({
    kind: 'restore',
    createdAt: new Date().toISOString(),
    archive,
    manifest: manifest,
    verification: restoreVerification,
    checks: [
      {
        name: '数据库恢复',
        status:
          migrationVersion === manifest.database.migration_version
            ? 'pass'
            : 'fail',
        detail: `迁移版本 ${migrationVersion}（${migrationCount} 个已应用）`,
      },
      {
        name: '对象传输',
        status: restoreVerification.consistent ? 'pass' : 'fail',
        detail: `${restoreVerification.missing.length} 缺失 / ${restoreVerification.extra.length} 未引用`,
      },
      {
        name: '账号与文档',
        status: reread.status === 200 ? 'pass' : 'fail',
        detail: `${email} 的会话与文档内容核对`,
      },
      {
        name: '附件内容',
        status: attachmentContent.buffer.equals(attachmentBytes)
          ? 'pass'
          : 'fail',
        detail: 'notes.txt 逐字节核对',
      },
      {
        name: '任务恢复',
        status: 'pass',
        detail: `排队导出 ${exported.body.id} 恢复为 succeeded`,
      },
      {
        name: '待处理上传失效',
        status: 'pass',
        detail: `${pendingId} 过期并幂等清理，无失败任务`,
      },
    ],
  });
  writeFileSync(join(archive, 'drill-report.md'), report);
  ensure(
    report.includes('PASS') && !report.includes('FAIL'),
    `the drill report must pass:\n${report}`,
  );

  console.log(
    [
      'Restore drill passed:',
      `- archive: ${archive} (dump + ${manifest.objects.count} verified objects + manifest + reports)`,
      `- restore: ${restore} rebuilt from the archive alone, production ${production} torn down`,
      `- verified: ${email} read back document and attachment bytes; export ${exported.body.id} succeeded`,
      '- pending upload expired and cleaned idempotently; no failed jobs',
      `- reports: ${join(archive, 'drill-report.md')}, ${join(archive, 'backup-report.md')}, ${join(archive, 'restore-report.md')}`,
    ].join('\n'),
  );
} catch (error) {
  throw new Error(`[${stage}] ${error.message}`, { cause: error });
} finally {
  try {
    for (const project of [restore, production]) {
      runCompose(project, envPath, [
        'down',
        '-v',
        '--remove-orphans',
        '--timeout',
        '60',
      ]);
    }
  } catch {
    // The stack may already be gone; cleanup is best effort.
  } finally {
    // Secrets never outlive the drill; the archive does, so the reports
    // stay reviewable (it holds drill data only, and .scratch is ignored).
    rmSync(envPath, { force: true });
    for (const certificate of [`${production}-root.crt`, `${restore}-root.crt`])
      rmSync(join(scratch, certificate), { force: true });
  }
}
