import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { root } from './process.mjs';
import { amzDateNow, signRequest } from './sigv4.mjs';

// Docker/compose and entrance helpers shared by the production backup,
// restore and drill scripts. Glue only: every behavior worth pinning is
// either in the unit-tested libs (sigv4, backup-manifest) or asserted by
// the scripts themselves at runtime.

export const composeFile = join(root, 'compose.production.yaml');

// The compose file fixes the production project name; restore targets must
// never reuse it (same name means same project-scoped volumes).
export function productionProjectName() {
  return /^name:\s*(\S+)/m.exec(readFileSync(composeFile, 'utf8'))[1];
}

export function composeArgs(project, envPath, profile) {
  return [
    'compose',
    '-f',
    composeFile,
    '-p',
    project,
    '--env-file',
    envPath,
    ...(profile ? ['--profile', profile] : []),
  ];
}

// ENV_FILE must be a real environment variable: it selects the service
// env_file, while --env-file only feeds compose file interpolation.
export function dockerEnv(envPath) {
  return { cwd: root, env: { ...process.env, ENV_FILE: envPath } };
}

export function runCompose(project, envPath, args, profile) {
  return execFileSync(
    'docker',
    [...composeArgs(project, envPath, profile), ...args],
    {
      ...dockerEnv(envPath),
      stdio: 'inherit',
    },
  );
}

export function captureCompose(project, envPath, args) {
  return execFileSync('docker', [...composeArgs(project, envPath), ...args], {
    ...dockerEnv(envPath),
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

export function runningServices(project, envPath) {
  return captureCompose(project, envPath, [
    'ps',
    '--status',
    'running',
    '--services',
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function apiImage(project, envPath) {
  // --all because the backup window stops api before the manifest is
  // written; compose ps without it only lists running containers.
  const parsed = JSON.parse(
    captureCompose(project, envPath, [
      'ps',
      '--all',
      '--format',
      'json',
      'api',
    ]),
  );
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) throw new Error('api service not found in project');
  return rows[0].Image;
}

export function psql(project, envPath, sql) {
  return captureCompose(project, envPath, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'labos_threejs',
    '-d',
    'labos_threejs',
    '-tAc',
    sql,
  ]).trim();
}

export function migrationState(project, envPath) {
  const [version, count] = psql(
    project,
    envPath,
    'SELECT max(version)::int, count(*) FROM _sqlx_migrations',
  )
    .split('|')
    .map(Number);
  return { version, count };
}

export function stopWithBudget(project, envPath, service, budgetSeconds) {
  const since = Date.now();
  runCompose(project, envPath, ['stop', service]);
  const elapsed = (Date.now() - since) / 1000;
  if (elapsed >= budgetSeconds)
    throw new Error(
      `${service} took ${elapsed.toFixed(1)}s to stop, at or beyond the ${budgetSeconds}s budget (it was killed, not drained)`,
    );
  return elapsed;
}

export function drainLogPresent(project, envPath, service) {
  return captureCompose(project, envPath, ['logs', service]).includes(
    service === 'api'
      ? 'draining HTTP requests'
      : 'stopping worker claims and draining current work',
  );
}

// The local Caddy authority signs certificates for localhost domains; real
// domains carry a publicly trusted chain, so the custom CA is only needed
// (and only substituted) for loopback origins.
export function originRootCa(project, envPath, origin, scratchDir) {
  const hostname = new URL(origin).hostname;
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return undefined;
  const certificate = captureCompose(project, envPath, [
    'exec',
    'caddy',
    'cat',
    '/data/caddy/pki/authorities/local/root.crt',
  ]);
  const path = join(scratchDir, `${project}-root.crt`);
  writeFileSync(path, certificate);
  return path;
}

export function request(method, url, { headers = {}, body, rootCa } = {}) {
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
    exchange.setTimeout(30_000, () =>
      exchange.destroy(new Error('request deadline')),
    );
    if (body === undefined) exchange.end();
    else exchange.end(body);
  });
}

// Object operations go through the same entrance the application uses; the
// signature covers the public origin, exactly like the app's presigned URLs.
export function s3Request(env, method, key, body, query = '', rootCa) {
  const endpoint = new URL(
    `${env.S3_PUBLIC_ENDPOINT}/${env.S3_BUCKET}/${key}${query}`,
  );
  const { headers } = signRequest({
    method,
    url: endpoint,
    headers: {
      'x-amz-date': amzDateNow(),
      ...(body === undefined
        ? {}
        : {
            'x-amz-content-sha256': createHash('sha256')
              .update(body)
              .digest('hex'),
          }),
    },
    body,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    region: env.S3_REGION ?? 'us-east-1',
    service: 's3',
  });
  return request(method, endpoint, { headers, body, rootCa });
}

export async function listObjects(env, rootCa) {
  const entries = [];
  let token = '';
  do {
    const tokenQuery = token
      ? `&continuation-token=${encodeURIComponent(token)}`
      : '';
    const page = await s3Request(
      env,
      'GET',
      '',
      undefined,
      `?list-type=2${tokenQuery}`,
      rootCa,
    );
    if (page.status !== 200)
      throw new Error(`bucket listing failed (${page.status})`);
    const xml = page.buffer.toString();
    const items = [
      ...xml.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g),
    ].map(([, key, size]) => ({ key: xmlUnescape(key), size: Number(size) }));
    entries.push(...items);
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
      xml,
    )?.[1];
  } while (token);
  return entries;
}

function xmlUnescape(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function readEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}
