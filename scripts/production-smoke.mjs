import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { root } from './lib/process.mjs';

// Single-machine production smoke: the real composition from
// compose.production.yaml behind the real Caddy TLS entrance. No browser and
// no shared development data; every secret is generated for this run and the
// scratch directory never leaves the machine.

const composeFile = join(root, 'compose.production.yaml');
const project = `labos-threejs-prod-smoke-${process.pid}`;

const scratch = mkdtempSync(join(root, '.scratch/production-smoke-'));
const password = randomBytes(18).toString('base64url');
const composeArgs = (envPath, profile) => [
  'compose',
  '-f',
  composeFile,
  '-p',
  project,
  '--env-file',
  envPath,
  ...(profile ? ['--profile', profile] : []),
];
// ENV_FILE must be a real environment variable: it selects the service
// env_file, while --env-file only feeds compose file interpolation.
const dockerEnv = (envPath) => ({
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ENV_FILE: envPath },
});

class SmokeFailure extends Error {}
function ensure(value, message) {
  if (!value) throw new SmokeFailure(message);
}
async function eventually(action, label, timeoutMs = 60_000) {
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
  throw new SmokeFailure(
    `Timed out: ${label}${last ? ` (${last.message})` : ''}`,
  );
}

function writeEnvFile() {
  writeFileSync(
    join(scratch, 'env.production'),
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
      // Mail and telemetry are deliberately configured but unreachable:
      // the journey below doubles as the degradation proof that ordinary
      // registration and writing survive both outages.
      'MAIL_SMTP_HOST=127.0.0.1',
      'MAIL_SMTP_PORT=1025',
      `MAIL_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
      'TELEMETRY_ENDPOINT=http://127.0.0.1:4317',
      '',
    ].join('\n'),
  );
  return join(scratch, 'env.production');
}

// The entrance uses Caddy's local CA for localhost; requests validate the
// real chain against the root certificate copied out of the container.
function request(method, url, { headers = {}, body, rootCa } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveRequest, rejectRequest) => {
    const exchange = transport(
      target,
      { method, headers, ...(rootCa ? { ca: readFileSync(rootCa) } : {}) },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolveRequest({
            status: response.statusCode,
            headers: response.headers,
            buffer: Buffer.concat(chunks),
          }),
        );
      },
    );
    exchange.on('error', rejectRequest);
    exchange.setTimeout(15_000, () =>
      exchange.destroy(new Error('request deadline')),
    );
    if (body === undefined) exchange.end();
    else exchange.end(body);
  });
}

async function json(method, url, init = {}) {
  const response = await request(method, url, {
    ...init,
    headers: {
      origin: 'https://localhost',
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      ...(init.cookie
        ? { cookie: init.cookie, 'x-csrf-token': init.csrf }
        : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body:
      response.status === 204
        ? undefined
        : JSON.parse(response.buffer.toString()),
  };
}

let cookie;
let csrf;
let base;
let rootCa;
async function application(path, method = 'GET', body) {
  const result = await json(method, `${base}${path}`, {
    body,
    cookie,
    csrf,
    rootCa,
  });
  const setCookie = result.headers['set-cookie'];
  if (setCookie?.length) {
    cookie = setCookie[0].split(';')[0];
    csrf = result.body?.csrf_token;
  }
  return result;
}

async function uploadAttachment(documentPath, name, bytes) {
  const upload = (
    await application(`${documentPath}/uploads`, 'POST', {
      file_name: name,
      content_type: 'text/plain',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  ).body;
  const put = await request('PUT', upload.upload.url, {
    headers: upload.upload.headers,
    body: bytes,
    rootCa,
  });
  return { upload, putStatus: put.status };
}

let stage = 'setup';
let envPath;
try {
  envPath = writeEnvFile();
  stage = 'web build';
  execFileSync('pnpm', ['--filter', '@labos-threejs/web', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
  stage = 'image build';
  execFileSync(
    'docker',
    [
      'build',
      '-f',
      join(root, 'deploy/production/Dockerfile'),
      '-t',
      'labos-threejs-production:local',
      root,
    ],
    { cwd: root, stdio: 'inherit' },
  );

  stage = 'internal dependencies';
  execFileSync(
    'docker',
    [
      ...composeArgs(envPath),
      'up',
      '-d',
      '--wait',
      'postgres',
      'redis',
      'rustfs',
    ],
    dockerEnv(envPath),
  );
  stage = 'explicit migration';
  execFileSync(
    'docker',
    [...composeArgs(envPath, 'ops'), 'run', '--rm', 'migrate'],
    dockerEnv(envPath),
  );
  stage = 'storage bootstrap';
  execFileSync(
    'docker',
    [...composeArgs(envPath, 'ops'), 'run', '--rm', 'storage-init'],
    dockerEnv(envPath),
  );
  stage = 'application start';
  execFileSync(
    'docker',
    [
      ...composeArgs(envPath),
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '180',
      'api',
      'worker',
      'caddy',
    ],
    dockerEnv(envPath),
  );

  stage = 'entrance';
  rootCa = join(scratch, 'caddy-root.crt');
  const certificate = execFileSync(
    'docker',
    [
      ...composeArgs(envPath),
      'exec',
      'caddy',
      'cat',
      '/data/caddy/pki/authorities/local/root.crt',
    ],
    { ...dockerEnv(envPath), stdio: 'pipe', encoding: 'utf8' },
  );
  writeFileSync(rootCa, certificate);
  base = 'https://localhost';
  const live = await request('GET', `${base}/health/live`, { rootCa });
  ensure(live.status === 200, 'health must pass the real TLS chain');
  const page = await request('GET', `${base}/`, { rootCa });
  ensure(
    page.status === 200 && page.buffer.toString().includes('<div id="root">'),
    'the web entry must serve the application',
  );
  ensure(
    Boolean(
      page.headers['strict-transport-security'] &&
      page.headers['content-security-policy'],
    ),
    'security headers must reach the browser',
  );
  const insecure = await request('GET', 'http://localhost/health/live', {});
  ensure(
    String(insecure.status).startsWith('3'),
    'plain HTTP must redirect to the TLS entrance',
  );

  stage = 'journey';
  const secret = `production-private-${randomUUID()}`;
  const email = `smoke-${randomBytes(6).toString('hex')}@example.test`;
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
      title: 'Production walkthrough',
      markdown: secret,
    })
  ).body;
  const documentPath = `/api/v1/knowledge/documents/${document.id}`;
  const first = await uploadAttachment(
    documentPath,
    'notes.txt',
    Buffer.from(secret),
  );
  ensure(
    first.putStatus >= 200 && first.putStatus < 300,
    'attachment transfer through caddy failed',
  );
  await application(
    `${documentPath}/uploads/${first.upload.upload_id}/complete`,
    'POST',
    {},
  );
  const reread = await application(documentPath, 'GET', undefined);
  ensure(
    reread.status === 200 && reread.body.markdown === secret,
    'the document must survive the full production round trip',
  );

  stage = 'restart persistence';
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'restart', 'api', 'worker'],
    dockerEnv(envPath),
  );
  await eventually(async () => {
    const ready = await request('GET', `${base}/health/ready`, { rootCa });
    return ready.status === 200;
  }, 'api readiness after restart');
  const afterRestart = await application(documentPath, 'GET', undefined);
  ensure(
    afterRestart.status === 200 && afterRestart.body.markdown === secret,
    'the session and document must survive a restart',
  );

  stage = 'redis outage';
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'stop', 'redis'],
    dockerEnv(envPath),
  );
  const degradedDocument = (
    await application('/api/v1/knowledge/documents', 'POST', {
      title: 'While redis is down',
      markdown: '# still writable',
    })
  ).body;
  ensure(Boolean(degradedDocument.id), 'writing must continue without redis');
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'start', 'redis'],
    dockerEnv(envPath),
  );

  stage = 'storage outage';
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'stop', 'rustfs'],
    dockerEnv(envPath),
  );
  const readDuringOutage = await application(documentPath, 'GET', undefined);
  ensure(
    readDuringOutage.status === 200 &&
      readDuringOutage.body.markdown === secret,
    'markdown lives in postgres and stays readable',
  );
  const pending = Buffer.from('uploaded after recovery');
  const outage = await uploadAttachment(documentPath, 'recovery.txt', pending);
  ensure(
    outage.putStatus >= 500 || outage.putStatus < 200,
    'the object write must fail while rustfs is down',
  );
  const completeOutage = await application(
    `${documentPath}/uploads/${outage.upload.upload_id}/complete`,
    'POST',
    {},
  );
  ensure(
    completeOutage.status === 503 && completeOutage.body?.error?.request_id,
    'completion must fail in a controlled, correlated way',
  );
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'start', 'rustfs'],
    dockerEnv(envPath),
  );
  await eventually(async () => {
    const retry = await uploadAttachment(documentPath, 'recovery.txt', pending);
    ensure(
      retry.putStatus >= 200 && retry.putStatus < 300,
      'object transfer after recovery',
    );
    await application(
      `${documentPath}/uploads/${retry.upload.upload_id}/complete`,
      'POST',
      {},
    );
    return true;
  }, 'upload recovery after rustfs returns');
  const attachments = (
    await application(`${documentPath}/attachments`, 'GET', undefined)
  ).body;
  ensure(
    JSON.stringify(attachments).includes('recovery.txt'),
    'the recovered attachment must be listed',
  );

  stage = 'database outage';
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'stop', 'postgres'],
    dockerEnv(envPath),
  );
  await eventually(async () => {
    const ready = await request('GET', `${base}/health/ready`, { rootCa });
    return ready.status === 503;
  }, 'readiness must fail while postgres is down');
  const unavailable = await application(documentPath, 'GET', undefined);
  ensure(
    unavailable.status === 503 && unavailable.body?.error?.request_id,
    'business reads must fail in a controlled way',
  );
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'start', 'postgres'],
    dockerEnv(envPath),
  );
  await eventually(async () => {
    const ready = await request('GET', `${base}/health/ready`, { rootCa });
    return ready.status === 200;
  }, 'readiness must recover without an api restart');
  const recovered = await application(documentPath, 'GET', undefined);
  ensure(
    recovered.status === 200 && recovered.body.markdown === secret,
    'the document must still be there after recovery',
  );

  stage = 'worker recovery';
  // Stopping the worker is also its graceful-drain proof: compose sends
  // SIGTERM and waits out stop_grace_period, so finishing well under it
  // shows the drain deadline was honored, not the kill.
  const workerStopStarted = Date.now();
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'stop', 'worker'],
    dockerEnv(envPath),
  );
  const workerStopSeconds = (Date.now() - workerStopStarted) / 1000;
  ensure(
    workerStopSeconds < 40,
    `worker must stop within its declared grace period, took ${workerStopSeconds}s`,
  );
  const workerLogs = execFileSync(
    'docker',
    [...composeArgs(envPath), 'logs', 'worker'],
    { ...dockerEnv(envPath), stdio: 'pipe', encoding: 'utf8' },
  );
  ensure(
    workerLogs.includes('stopping worker claims and draining current work'),
    'stopping the worker must exercise its claim-drain path',
  );
  const exported = await application(`${documentPath}/exports`, 'POST', {});
  ensure(
    (exported.status === 200 || exported.status === 202) && exported.body.id,
    'the export request must be accepted while the worker is stopped',
  );
  const exportPath = `${documentPath}/exports/${exported.body.id}`;
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'start', 'worker'],
    dockerEnv(envPath),
  );
  await eventually(async () => {
    const result = await application(exportPath, 'GET', undefined);
    return result.body.status === 'succeeded' ? result.body : undefined;
  }, 'the restarted worker must finish the queued export');
  const download = (
    await application(`${exportPath}/download`, 'GET', undefined)
  ).body;
  const archive = await request('GET', download.url, { rootCa });
  ensure(archive.status === 200, 'export download through caddy failed');
  ensure(
    strFromU8(unzipSync(new Uint8Array(archive.buffer))['document.md']) ===
      secret,
    'the exported markdown must match the original',
  );

  stage = 'graceful drain';
  const before = Date.now();
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'stop', 'api'],
    dockerEnv(envPath),
  );
  const seconds = (Date.now() - before) / 1000;
  // 25s sits below the 30s grace period on purpose: a forced kill would
  // land near 30s, so passing here proves the process exited on its own.
  ensure(
    seconds < 25,
    `api must stop within its drain budget, took ${seconds}s`,
  );
  const logs = execFileSync(
    'docker',
    [...composeArgs(envPath), 'logs', 'api'],
    { ...dockerEnv(envPath), stdio: 'pipe', encoding: 'utf8' },
  );
  ensure(
    logs.includes('draining HTTP requests'),
    'stopping the container must exercise the drain path',
  );
  execFileSync(
    'docker',
    [...composeArgs(envPath), 'start', 'api'],
    dockerEnv(envPath),
  );
  await eventually(async () => {
    const ready = await request('GET', `${base}/health/ready`, { rootCa });
    return ready.status === 200;
  }, 'api readiness after drain');

  console.log(
    [
      'Production smoke passed:',
      `- entrance: ${base} with real TLS, security headers and an HTTP redirect`,
      `- journey: ${email} registered as owner, wrote and re-read a document with attachments`,
      '- restart: session and data survived an api/worker restart',
      '- degradation: redis, rustfs and postgres outages each failed the way the matrix promises',
      '- degraded companions: mail and telemetry were configured but unreachable the whole time',
      '- recovery: queued export finished after the worker returned; api and worker drains honored their grace periods',
    ].join('\n'),
  );
} catch (error) {
  throw new Error(`[${stage}] ${error.message}`, { cause: error });
} finally {
  try {
    if (envPath)
      execFileSync(
        'docker',
        [
          ...composeArgs(envPath),
          'down',
          '-v',
          '--remove-orphans',
          '--timeout',
          '60',
        ],
        dockerEnv(envPath),
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
