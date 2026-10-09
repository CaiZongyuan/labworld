import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../scripts/lib/process.mjs';

const composeFile = join(root, 'compose.production.yaml');
const envExample = join(root, 'deploy/production/env.production.example');
const caddyfile = join(root, 'deploy/production/Caddyfile');
const dockerfile = join(root, 'deploy/production/Dockerfile');

// The example doubles as the fixture for `docker compose config`; it must be
// complete enough that the production contract validates without secrets.
function productionConfig(profile) {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        '--env-file',
        envExample,
        ...(profile ? ['--profile', profile] : []),
        'config',
        '--format',
        'json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ENV_FILE: envExample },
      },
    ),
  );
}

function service(config, name) {
  const service = config.services[name];
  assert.ok(service, `production compose must define ${name}`);
  return service;
}

function memoryBytes(limit) {
  const match = /^(\d+)([bkmg])?$/i.exec(String(limit));
  assert.ok(match, `unsupported memory limit ${limit}`);
  const scale = { undefined: 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(match[1]) * scale[(match[2] ?? 'undefined').toLowerCase()];
}

const DRAIN_BUDGET = {
  // API: 3s HTTP drain + 1s pool close + the bounded telemetry flush
  // (2s trace deadline plus the SDK's own bounded wait), kept conservative.
  api: 14,
  // Worker: same budgets plus the 10s default JOB_SHUTDOWN_SECS work drain.
  worker: 24,
};

test('the production compose file exists with its deployment assets', () => {
  assert.ok(existsSync(composeFile), 'compose.production.yaml is required');
  assert.ok(existsSync(envExample), 'env.production.example is required');
  assert.ok(existsSync(caddyfile), 'Caddyfile is required');
  assert.ok(existsSync(dockerfile), 'Dockerfile is required');
});

test('only the TLS entrance is reachable from outside the machine', () => {
  const config = productionConfig();
  for (const name of Object.keys(config.services)) {
    const published = (service(config, name).ports ?? []).map(
      (port) => `${port.published}:${port.target}`,
    );
    if (name === 'caddy') {
      assert.deepEqual(
        published.sort(),
        ['443:443', '80:80'],
        'the entrance publishes exactly HTTP and HTTPS',
      );
    } else {
      assert.deepEqual(
        published,
        [],
        `${name} must stay on the internal compose network`,
      );
    }
  }
});

test('long-running services restart, report health and stay bounded', () => {
  const config = productionConfig();
  for (const name of [
    'caddy',
    'api',
    'worker',
    'postgres',
    'redis',
    'rustfs',
  ]) {
    const entry = service(config, name);
    assert.equal(
      entry.restart,
      'unless-stopped',
      `${name} must come back after an unattended failure`,
    );
    assert.ok(
      entry.healthcheck?.test?.length,
      `${name} must expose a container healthcheck`,
    );
    const limits = entry.deploy?.resources?.limits;
    assert.ok(
      limits && memoryBytes(limits.memory) > 0 && Number(limits.cpus) > 0,
      `${name} needs memory and cpu boundaries`,
    );
    assert.equal(
      entry.logging?.driver,
      'json-file',
      `${name} logs must rotate on a single machine`,
    );
    assert.ok(
      Number(entry.logging?.options?.['max-file']) > 1,
      `${name} logs must keep more than one rotation file`,
    );
  }
});

test('data keeps persistent volumes while cache state does not pretend to', () => {
  const config = productionConfig();
  const mounts = (name) =>
    (service(config, name).volumes ?? []).map((volume) => [
      volume.type,
      volume.source,
      volume.target,
    ]);
  for (const [name, source] of [
    ['postgres', 'postgres-data'],
    ['rustfs', 'rustfs-data'],
    ['caddy', 'caddy-data'],
  ]) {
    assert.ok(
      mounts(name).some(
        ([type, named]) => type === 'volume' && named === source,
      ),
      `${name} must persist on the named volume ${source}`,
    );
  }
  assert.ok(
    mounts('redis').every(([, source]) => source === undefined),
    'redis is a cache; durable volumes would imply more reliability than it has',
  );
  const caddy = service(config, 'caddy');
  const readOnly = (caddy.volumes ?? []).find(
    (volume) => volume.target === '/srv/web',
  );
  assert.equal(
    readOnly?.read_only,
    true,
    'static web assets are build artifacts, not writable state',
  );
});

test('shutdown deadlines leave room for the drain the binaries promise', () => {
  const config = productionConfig();
  const grace = (name) => {
    const value = service(config, name).stop_grace_period;
    assert.ok(value, `${name} must declare stop_grace_period`);
    const match = /^(\d+)s$/.exec(value);
    assert.ok(match, `unsupported stop_grace_period ${value}`);
    return Number(match[1]);
  };
  assert.ok(
    grace('api') >= DRAIN_BUDGET.api,
    'api grace must cover HTTP drain, pool close and telemetry flush',
  );
  assert.ok(
    grace('worker') >= DRAIN_BUDGET.worker,
    'worker grace must cover active-work drain on top of the api budgets',
  );
});

test('migrations and storage bootstrap are explicit one-shot operations', () => {
  const config = productionConfig('ops');
  const applicationImage = service(config, 'api').image;
  assert.ok(applicationImage, 'api declares its production image');
  for (const name of ['worker', 'migrate', 'storage-init']) {
    assert.equal(
      service(config, name).image,
      applicationImage,
      `${name} must run the exact image that serves production`,
    );
  }
  for (const name of ['migrate', 'storage-init']) {
    const entry = service(config, name);
    assert.ok(
      entry.profiles?.includes('ops'),
      `${name} must stay out of docker compose up`,
    );
    for (const other of Object.keys(config.services)) {
      assert.ok(
        !JSON.stringify(service(config, other).depends_on ?? '').includes(name),
        `${name} must never be pulled in by ${other} startup`,
      );
    }
  }
  // The whole point of the explicit contract: a plain `up` (and even the
  // default `config` view) never sees the one-shots.
  const unprofiled = productionConfig();
  for (const name of ['migrate', 'storage-init']) {
    assert.equal(
      unprofiled.services[name],
      undefined,
      `${name} must not start with the production stack`,
    );
  }
  for (const name of ['api', 'worker']) {
    const command = JSON.stringify([
      ...(service(config, name).entrypoint ?? []),
      ...(service(config, name).command ?? []),
    ]);
    assert.doesNotMatch(
      command,
      /migrate|bootstrap/i,
      `${name} must not migrate implicitly`,
    );
  }
});

test('a deployment without its environment file fails loudly and early', () => {
  const env = { ...process.env };
  delete env.ENV_FILE;
  let error;
  try {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        '--env-file',
        envExample,
        'config',
        '--format',
        'json',
      ],
      { cwd: root, encoding: 'utf8', env },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'compose must refuse to resolve the application services');
  assert.match(
    String(error.stderr),
    /ENV_FILE/,
    'the failure must name the missing variable and point at the example',
  );
});

test('the application processes run hardened containers', () => {
  const config = productionConfig();
  for (const name of ['api', 'worker']) {
    const entry = service(config, name);
    assert.equal(
      entry.read_only,
      true,
      `${name} writes no local files; its root filesystem must be read-only`,
    );
    assert.ok(
      (entry.tmpfs ?? []).length > 0,
      `${name} still needs a writable /tmp`,
    );
    const network = Object.keys(entry.networks ?? {});
    assert.deepEqual(
      network,
      ['internal'],
      `${name} joins only the internal network`,
    );
  }
  const caddyNetworks = Object.keys(service(config, 'caddy').networks ?? {});
  assert.deepEqual(caddyNetworks, ['internal'], 'caddy joins the same network');
  assert.match(
    readFileSync(dockerfile, 'utf8'),
    /USER \S+/,
    'runtime containers must not run as root',
  );
});

test('the entrance terminates TLS and serves the three routes', () => {
  const source = readFileSync(caddyfile, 'utf8');
  assert.match(
    source,
    /\{\$DOMAIN:-localhost\}/,
    'the site address comes from the deployment domain',
  );
  assert.match(source, /admin off/, 'the caddy admin endpoint stays off');
  assert.match(source, /encode /, 'the entrance compresses responses');
  for (const header of [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'Content-Security-Policy',
    'Referrer-Policy',
  ]) {
    assert.ok(source.includes(header), `missing ${header}`);
  }
  assert.match(source, /reverse_proxy api:3000/, 'API traffic is proxied');
  assert.match(
    source,
    /reverse_proxy rustfs:9000/,
    'object storage traffic is proxied so presigned URLs stay valid',
  );
  assert.match(source, /file_server/, 'static web assets are served');
  assert.match(
    source,
    /try_files \{path\} \/index\.html/,
    'the single-page application falls back to its entry document',
  );
});

test('the deployment example keeps application traffic inside the network', () => {
  const example = readFileSync(envExample, 'utf8');
  const value = (name) => {
    const match = new RegExp(`^${name}=(.*)$`, 'm').exec(example);
    return match?.[1]?.trim();
  };
  assert.match(
    value('DATABASE_URL') ?? '',
    /@postgres:5432\//,
    'the database is reached by its service name',
  );
  assert.equal(
    value('REDIS_URL'),
    'redis://redis:6379/',
    'redis is reached by its service name',
  );
  assert.equal(
    value('S3_ENDPOINT'),
    'http://rustfs:9000',
    'object storage is reached by its service name',
  );
  assert.match(
    value('APP_ORIGIN') ?? '',
    /^https:\/\//,
    'the trusted origin is HTTPS so session cookies gain Secure',
  );
  assert.equal(
    value('S3_PUBLIC_ENDPOINT'),
    value('APP_ORIGIN'),
    'presigned URLs share the application origin so caddy can route them',
  );
  assert.ok(
    !/[A-Za-z0-9+/]{40,}/.test(example.replace(/^#\s.*$/gm, '')),
    'the committed example must not contain real secrets',
  );
});

test('the build context can never carry secrets into an image', () => {
  const ignore = readFileSync(join(root, '.dockerignore'), 'utf8');
  for (const rule of ['.secrets', '.env']) {
    assert.match(
      ignore,
      new RegExp(`^${rule}$`, 'm'),
      `.dockerignore needs ${rule}`,
    );
  }
});
