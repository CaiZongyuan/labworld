#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  composeArgs,
  dockerEnv,
  listObjects,
  migrationState,
  originRootCa,
  productionProjectName,
  readEnvFile,
  request,
  runCompose,
  s3Request,
} from './lib/production-stack.mjs';
import { renderReport, verifyObjects } from './lib/backup-manifest.mjs';
import { root } from './lib/process.mjs';

// Restore an archive produced by production-backup.mjs into an independent,
// empty environment: a compose project of its own with fresh volumes and
// networks. It never touches an existing deployment — the target project
// must differ from the production project name, and the operator performs
// any switch-over explicitly afterwards.
//
//   node scripts/production-restore.mjs --env-file .env.production --archive backups/<ts>
//
// Leaves the restored stack running for inspection; verify content and jobs
// (the drill automates this), then switch traffic over or tear it down.

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    archive: { type: 'string' },
    project: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['env-file', 'archive'],
});
const envPath = isAbsolute(values['env-file'])
  ? values['env-file']
  : resolve(root, values['env-file']);
const archive = isAbsolute(values.archive)
  ? values.archive
  : resolve(root, values.archive);
const reportPath = values.report
  ? isAbsolute(values.report)
    ? values.report
    : resolve(root, values.report)
  : join(archive, 'restore-report.md');

for (const path of [
  envPath,
  join(archive, 'database.dump'),
  join(archive, 'manifest.json'),
])
  if (!existsSync(path)) throw new Error(`missing restore input: ${path}`);

const production = productionProjectName();
const restore =
  values.project ??
  `${production}-restore-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
if (restore === production)
  throw new Error(
    `restore target must be an independent project, not ${production}: same name means same volumes`,
  );

const env = readEnvFile(envPath);
const manifest = JSON.parse(
  readFileSync(join(archive, 'manifest.json'), 'utf8'),
);
const checks = [];
const scratch = mkdtempSync(join(tmpdir(), 'restore-rootca-'));
let restoreVerification = {
  consistent: false,
  missing: [],
  size_mismatch: [],
  extra: [],
};

function writeReport() {
  writeFileSync(
    reportPath,
    renderReport({
      kind: 'restore',
      createdAt: new Date().toISOString(),
      archive,
      manifest,
      verification: restoreVerification,
      checks,
    }),
  );
}
function fail(name, detail, message) {
  checks.push({ name, status: 'fail', detail: detail ?? message });
  writeReport();
  throw new Error(message);
}

runCompose(restore, envPath, [
  'up',
  '-d',
  '--wait',
  'postgres',
  'redis',
  'rustfs',
]);
const restored = spawnSync(
  'docker',
  [
    ...composeArgs(restore, envPath),
    'exec',
    '-T',
    'postgres',
    'pg_restore',
    '-U',
    'labos_threejs',
    '-d',
    'labos_threejs',
    '--no-owner',
    '--exit-on-error',
  ],
  {
    ...dockerEnv(envPath),
    input: readFileSync(join(archive, 'database.dump')),
    stdio: ['pipe', 'inherit', 'inherit'],
  },
);
if (restored.status !== 0)
  throw new Error(
    `pg_restore failed with exit code ${restored.status}; the target database is partial — tear down project ${restore} and retry`,
  );
runCompose(restore, envPath, ['run', '--rm', 'storage-init'], 'ops');

// The entrance comes up before the applications: object transfers are
// signed against the public origin and travel through caddy, exactly like
// the application's own presigned URLs.
runCompose(restore, envPath, ['up', '-d', '--wait', 'caddy']);

// The archive carries no keys; the deployment's own environment file and a
// fresh local root CA (scratch, never the archive) open the way in.
const rootCa = originRootCa(restore, envPath, env.APP_ORIGIN, scratch);
let restoredObjects = 0;
for (const object of manifest.objects.entries) {
  const bytes = readFileSync(
    join(archive, 'objects', object.object_key.replaceAll('/', '__')),
  );
  const put = await s3Request(env, 'PUT', object.object_key, bytes, '', rootCa);
  if (put.status < 200 || put.status >= 300)
    fail(
      '对象传输',
      `对象 ${object.file_id} 回传失败 (${put.status})`,
      `object restore failed for ${object.file_id} (${put.status})`,
    );
  restoredObjects += 1;
}

runCompose(restore, envPath, [
  'up',
  '-d',
  '--wait',
  '--wait-timeout',
  '180',
  'api',
  'worker',
  'caddy',
]);

const ready = await request('GET', `${env.APP_ORIGIN}/health/ready`, {
  rootCa,
});
if (ready.status !== 200)
  fail(
    '服务就绪',
    `/health/ready 返回 ${ready.status}`,
    `restored stack did not become ready (${ready.status})`,
  );
checks.push({
  name: '服务就绪',
  status: 'pass',
  detail: '恢复栈经入口达到 ready',
});

const { version: migrationVersion, count: migrationCount } = migrationState(
  restore,
  envPath,
);
checks.push({
  name: '数据库恢复',
  status:
    migrationVersion === manifest.database.migration_version ? 'pass' : 'fail',
  detail: `迁移版本 ${migrationVersion}（${migrationCount} 个已应用）`,
});
if (migrationVersion !== manifest.database.migration_version)
  fail(
    '数据库恢复',
    undefined,
    'restored migration version disagrees with the manifest',
  );

restoreVerification = verifyObjects(manifest, await listObjects(env, rootCa));
checks.push({
  name: '对象传输',
  status: restoreVerification.consistent ? 'pass' : 'fail',
  detail: restoreVerification.consistent
    ? `${restoredObjects} 个对象回传后与清单一致（未引用对象 ${restoreVerification.extra.length} 个）`
    : `缺失 ${restoreVerification.missing.length} 个、大小不符 ${restoreVerification.size_mismatch.length} 个`,
});
if (!restoreVerification.consistent)
  fail('对象传输', undefined, 'restored bucket disagrees with the manifest');

writeReport();
console.log(
  [
    'Restore complete (independent environment):',
    `- project: ${restore} (production is ${production}; switch-over is a manual, explicit step)`,
    `- source archive: ${archive} (migration ${manifest.database.migration_version}, ${restoredObjects} objects)`,
    `- report: ${reportPath}`,
    `- teardown: docker compose -f compose.production.yaml -p ${restore} --env-file ${values['env-file']} down -v`,
  ].join('\n'),
);
