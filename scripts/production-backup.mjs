#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  apiImage,
  composeArgs,
  dockerEnv,
  drainLogPresent,
  listObjects,
  originRootCa,
  migrationState,
  psql,
  productionProjectName,
  readEnvFile,
  runningServices,
  s3Request,
  stopWithBudget,
} from './lib/production-stack.mjs';
import {
  buildManifest,
  renderReport,
  verifyObjects,
} from './lib/backup-manifest.mjs';
import { root } from './lib/process.mjs';

// Maintenance-window backup of a running single-machine deployment: drain
// api and worker, snapshot the database, verify every database-referenced
// ready object against the bucket, and archive both with a reviewable
// report. Secrets stay out of the archive — they live in the deployment's
// own environment file and are supplied again at restore time.
//
//   node scripts/production-backup.mjs --env-file .env.production --archive backups/<ts>
//
// Leaves the stack stopped (window exit): restart with just production-up.

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    archive: { type: 'string' },
    project: { type: 'string' },
  },
  required: ['env-file', 'archive'],
});
const envPath = isAbsolute(values['env-file'])
  ? values['env-file']
  : resolve(root, values['env-file']);
const archive = isAbsolute(values.archive)
  ? values.archive
  : resolve(root, values.archive);
const project = values.project ?? productionProjectName();

if (!existsSync(envPath)) throw new Error(`env file not found: ${envPath}`);
if (existsSync(archive) && readdirSync(archive).length > 0)
  throw new Error(`archive directory is not empty: ${archive}`);
mkdirSync(join(archive, 'objects'), { recursive: true });

const env = readEnvFile(envPath);
const up = runningServices(project, envPath);
// The worker may legitimately already be stopped (an operator or the drill
// drained it just before the window); postgres and api must be up.
for (const service of ['postgres', 'api'])
  if (!up.includes(service))
    throw new Error(
      `${service} is not running in project ${project}; the maintenance window needs the live stack (just production-up)`,
    );

const checks = [];

// Once the window has started, every failure still produces a FAIL report:
// the archive must record how far the backup got, not just crash.
let manifest;
let verification;
function fail(message) {
  if (manifest) {
    writeFileSync(
      join(archive, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
    writeFileSync(
      join(archive, 'backup-report.md'),
      renderReport({
        kind: 'backup',
        createdAt: manifest.created_at,
        archive,
        manifest,
        verification,
        checks: [...checks, { name: '中断', status: 'fail', detail: message }],
      }),
    );
  }
  throw new Error(message);
}

// The window: freeze new mutations at the entrance, then let the worker
// finish claimed work. Both must drain on their own budgets — being killed
// at the compose grace period would leave in-flight state unverified.
stopWithBudget(project, envPath, 'api', 25);
if (!drainLogPresent(project, envPath, 'api'))
  fail('api stopped without its HTTP drain log line');
checks.push({
  name: 'api 排空',
  status: 'pass',
  detail: 'HTTP 在途请求排空后停止，日志有 draining 记录',
});

if (up.includes('worker')) stopWithBudget(project, envPath, 'worker', 40);
if (!drainLogPresent(project, envPath, 'worker'))
  fail('worker stopped without its claim-drain log line');
checks.push({
  name: 'worker 排空',
  status: 'pass',
  detail: '认领任务收尾后停止，日志有 draining 记录',
});

// Consistent point: no writers remain. The dump and the manifest are taken
// against the same stopped state, and ready objects are immutable, so the
// archive is self-consistent by construction and verified below anyway.
const dumpFd = openSync(join(archive, 'database.dump'), 'w');
const dumped = spawnSync(
  'docker',
  [
    ...composeArgs(project, envPath),
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '-U',
    'labos_threejs',
    '-Fc',
    'labos_threejs',
  ],
  { ...dockerEnv(envPath), stdio: ['ignore', dumpFd, 'inherit'] },
);
closeSync(dumpFd);
if (dumped.status !== 0) fail(`pg_dump failed with exit code ${dumped.status}`);
const { version: migrationVersion, count: migrationCount } = migrationState(
  project,
  envPath,
);
checks.push({
  name: '数据库快照',
  status: 'pass',
  detail: `pg_dump 自定义格式，迁移版本 ${migrationVersion}`,
});

const image = apiImage(project, envPath);
const repoDigests = JSON.parse(
  spawnSync(
    'docker',
    ['image', 'inspect', image, '--format', '{{json .RepoDigests}}'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).stdout,
);
// A locally built image has no registry digest; its id is the identity the
// archive records. Pulled images report their repo digest instead.
const imageDigest =
  repoDigests.length > 0
    ? repoDigests[0]
    : spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
        cwd: root,
        encoding: 'utf8',
      }).stdout.trim();

const readyRows = psql(
  project,
  envPath,
  "SELECT f.id::text, f.bucket, f.ready_key, encode(f.sha256, 'hex'), f.actual_size::bigint FROM labos_threejs_core.files f WHERE f.state = 'ready' AND f.ready_key IS NOT NULL ORDER BY f.id",
);
manifest = buildManifest({
  createdAt: new Date().toISOString(),
  image,
  imageDigest,
  dumpFile: 'database.dump',
  migrationVersion,
  migrationCount,
  objects: readyRows
    .split('\n')
    .filter((row) => row.length > 0)
    .map((row) => {
      const [file_id, bucket, object_key, sha256, size_bytes] = row.split('|');
      return {
        file_id,
        bucket,
        object_key,
        sha256,
        size_bytes: Number(size_bytes),
      };
    }),
});

// The local Caddy root CA can mint origin certificates — it stays in a
// scratch directory, never in the archive.
const rootCa = originRootCa(
  project,
  envPath,
  env.APP_ORIGIN,
  mkdtempSync(join(tmpdir(), 'backup-rootca-')),
);
verification = verifyObjects(manifest, await listObjects(env, rootCa));
checks.push({
  name: '对象清单',
  status: verification.consistent ? 'pass' : 'fail',
  detail: verification.consistent
    ? `${manifest.objects.count} 个 ready 对象与桶一致`
    : `缺失 ${verification.missing.length} 个、大小不符 ${verification.size_mismatch.length} 个`,
});
if (!verification.consistent)
  fail('bucket listing disagrees with the manifest');

let objectsVerified = 0;
for (const object of manifest.objects.entries) {
  const stored = await s3Request(
    env,
    'GET',
    object.object_key,
    undefined,
    '',
    rootCa,
  );
  if (stored.status !== 200)
    fail(`object download failed for ${object.file_id} (${stored.status})`);
  if (
    createHash('sha256').update(stored.buffer).digest('hex') !== object.sha256
  )
    fail(`object content digest mismatch for ${object.file_id}`);
  writeFileSync(
    join(archive, 'objects', object.object_key.replaceAll('/', '__')),
    stored.buffer,
  );
  objectsVerified += 1;
}
checks.push({
  name: '对象下载核对',
  status: 'pass',
  detail: `${objectsVerified} 个对象按数据库摘要逐字节核对`,
});

writeFileSync(
  join(archive, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);
writeFileSync(
  join(archive, 'backup-report.md'),
  renderReport({
    kind: 'backup',
    createdAt: manifest.created_at,
    archive,
    manifest,
    verification,
    checks,
  }),
);

console.log(
  [
    'Backup complete:',
    `- archive: ${archive}`,
    `- database.dump (${manifest.database.migration_version}) + ${objectsVerified} verified objects + manifest.json`,
    `- report: ${join(archive, 'backup-report.md')}`,
    `- the stack is stopped; restart with: just production-up ENV_FILE=${values['env-file']}`,
  ].join('\n'),
);
