import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  developmentEnv,
  freePort,
  root,
  stop,
  waitFor,
} from '../lib/process.mjs';
import { aggregate } from './report.mjs';

// The controlled load stack of spec §17.3: the committed dev compose file
// under a dedicated project name with per-run free ports, so a load run can
// never touch the development stack (project-scoped volumes, own data) or
// any database the user already has. The api/worker run on the host from a
// release build, which is what a capacity reading should measure. Cleanup
// is unconditional by default: `down -v` removes the project's volumes;
// PERF_STACK_KEEP=1 leaves the stack up for inspection and prints the
// teardown command.

export const project = 'labos-threejs-perf';

const scratch = join(root, '.scratch', 'perf');
const stackLogs = join(scratch, 'stack-logs');
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, 'target');

let currentEnv = null;

// §21 command contracts promise actionable errors: a missing or stopped
// Docker daemon is the most common blocker, so it gets named before the
// compose call fails with a bare ENOENT.
export function requireDocker() {
  // Reachability check only — `docker info` exits non-zero when the daemon
  // is down. No --format template: its fields have varied across versions.
  try {
    execFileSync('docker', ['info'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    console.error(
      'Docker is required for the controlled load stack but is not reachable.\n' +
        'Start Docker (or check `docker info`) and run the command again.',
    );
    process.exit(1);
  }
}

function compose(args, { capture = false } = {}) {
  return execFileSync(
    'docker',
    ['compose', '-f', join(root, 'compose.yaml'), '-p', project, ...args],
    {
      cwd: root,
      env: currentEnv ?? process.env,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    },
  );
}

export function requireK6() {
  try {
    return execFileSync('k6', ['version'], { encoding: 'utf8' }).trim();
  } catch {
    console.error(
      'k6 is required for the load scenarios but was not found on PATH.\n' +
        'Install it for your platform (https://grafana.com/docs/k6/latest/set-up/install-k6/);\n' +
        'the reports in this repository were produced with k6 v2.3.0.',
    );
    process.exit(1);
  }
}

// Samples connection-pool usage, queue depth and process RSS on an interval
// while a scenario runs. Aggregate min/avg/max lands in the report next to
// the k6 numbers; raw samples stay in so a spike can be located in time.
export function startSampler(
  sampleMs = Number(process.env.PERF_SAMPLE_MS ?? 2000),
) {
  const samples = [];
  const pids = { api: null, worker: null };
  let container = null;
  const POOL_SQL =
    "SELECT count(*), count(*) FILTER (WHERE state = 'active') FROM pg_stat_activity WHERE datname = 'labos_threejs' AND application_name <> 'postgres'";
  const JOBS_SQL =
    'SELECT status, count(*) FROM labos_threejs_core.jobs GROUP BY status';

  const psql = (sql) =>
    execFileSync(
      'docker',
      ['exec', container, 'psql', '-U', 'labos_threejs', '-d', 'labos_threejs', '-tAc', sql],
      {
        encoding: 'utf8',
        env: currentEnv ?? process.env,
      },
    ).trim();

  // The sampler starts before the stack exists; resolve the postgres
  // container lazily on the first tick after `compose up` and silently skip
  // samples until then.
  const ensureContainer = () => {
    if (container) return true;
    const id = compose(['ps', '-q', 'postgres'], { capture: true }).trim();
    if (!id) return false;
    container = id;
    return true;
  };

  const tick = () => {
    try {
      if (!ensureContainer()) return;
      const pool = psql(POOL_SQL).split('|').map(Number);
      const jobs = {};
      for (const line of psql(JOBS_SQL).split('\n').filter(Boolean)) {
        const [status, count] = line.split('|');
        jobs[status] = Number(count);
      }
      const rss = (pid) => {
        if (!pid) return null;
        try {
          return Number(
            /^VmRSS:\s+(\d+)/m.exec(
              readFileSync(`/proc/${pid}/status`, 'utf8'),
            )[1],
          );
        } catch {
          return null; // the process is gone; this sample has no value
        }
      };
      samples.push({
        at: new Date().toISOString(),
        poolConnections: pool[0],
        poolActive: pool[1],
        jobs,
        apiRssKiB: rss(pids.api),
        workerRssKiB: rss(pids.worker),
      });
    } catch {
      // A failed sample (container restarting, psql busy) is a gap, not a failure.
    }
  };

  const timer = setInterval(tick, sampleMs);
  timer.unref?.();
  return {
    watch(child, name) {
      pids[name] = child.pid;
    },
    async stop() {
      clearInterval(timer);
      // aggregate() moved to report.mjs (pure shaping, unit-tested); this is
      // just the sampling boundary.
      return aggregate(samples, sampleMs);
    },
  };
}

// Brings the whole controlled stack up and returns the running children plus
// the env a scenario needs to reach it. Reuses nothing: a leftover project
// from a crashed run is torn down first, so every run starts from clean data.
export async function startStack() {
  mkdirSync(scratch, { recursive: true });
  console.log(
    '[stack] building release binaries (cached after the first run)...',
  );
  execFileSync(
    'cargo',
    ['build', '--locked', '--release', '-p', 'labos-threejs-api', '-p', 'labos-threejs-worker'],
    {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    },
  );

  const ports = {
    POSTGRES_PORT: await freePort(),
    REDIS_PORT: await freePort(),
    RUSTFS_PORT: await freePort(),
    MAILPIT_SMTP_PORT: await freePort(),
    MAILPIT_HTTP_PORT: await freePort(),
  };
  const apiPort = await freePort();
  const workerPort = await freePort();

  // developmentEnv() carries the development mail key handling and every
  // default the binaries need; everything below overrides the wiring so
  // this stack is fully separate from the development one regardless of a
  // local .env.
  currentEnv = {
    ...developmentEnv(),
    ...ports,
    POSTGRES_PASSWORD: 'perf-local',
    DATABASE_URL: `postgres://labos_threejs:perf-local@127.0.0.1:${ports.POSTGRES_PORT}/labos_threejs`,
    REDIS_URL: `redis://127.0.0.1:${ports.REDIS_PORT}/`,
    CACHE_PREFIX: 'perf',
    S3_ENDPOINT: `http://127.0.0.1:${ports.RUSTFS_PORT}`,
    S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${ports.RUSTFS_PORT}`,
    S3_BUCKET: 'perf-files',
    APP_BIND: `127.0.0.1:${apiPort}`,
    APP_ORIGIN: 'http://127.0.0.1:5173',
    WORKER_BIND: `127.0.0.1:${workerPort}`,
    MAIL_SMTP_PORT: String(ports.MAILPIT_SMTP_PORT),
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_WINDOW_SECS: '60',
    // Capacity readings measure the application, not the default local
    // throttles (registration 20/min would drown a seeding loop). The
    // scenarios still classify a 429 as an expected throttle, so a run
    // against tightened limits stays honest. The fallback limits are widened
    // for the same reason: when a Redis counter op misses its budget under
    // load, the limiter degrades to the local per-peer fallback bucket, and
    // at k6 concurrency the defaults (resource 120/min) would turn the whole
    // window into a 429 storm instead of a capacity reading.
    RATE_LIMIT_REGISTRATION: '1000000',
    RATE_LIMIT_AUTHENTICATION: '1000000',
    RATE_LIMIT_RESOURCE: '1000000',
    RATE_LIMIT_REGISTRATION_FALLBACK: '1000000',
    RATE_LIMIT_AUTHENTICATION_FALLBACK: '1000000',
    RATE_LIMIT_RESOURCE_FALLBACK: '1000000',
    TELEMETRY_ENDPOINT: '',
  };

  // The compose file names the dev project; -p overrides it and its volumes
  // stay project-scoped, so down -v cleans exactly what this stack created.
  compose(['down', '--volumes', '--remove-orphans']);
  compose(['up', '-d', '--wait', 'postgres', 'redis', 'rustfs', 'mailpit']);
  console.log('[stack] dependencies ready; applying migrations...');
  for (const bin of ['migrate', 'bootstrap-storage']) {
    execFileSync(join(targetDir, 'release', bin), {
      cwd: root,
      env: currentEnv,
      stdio: 'inherit',
    });
  }

  // detached puts each child in its own process group, which is what
  // stop() (via lib/process.mjs) signals — without it the group kill is a
  // silent no-op and orphaned binaries keep the runner alive forever.
  // Both output streams go to files, not pipes: pipes would keep this
  // runner's event loop alive after a PERF_STACK_KEEP run, a kept stack
  // would stall once a full pipe buffer blocked the binary's logging, and
  // the binaries log to stdout, which would otherwise be lost entirely.
  mkdirSync(stackLogs, { recursive: true });
  const run = (name) => {
    const log = openSync(join(stackLogs, `${name}.log`), 'a');
    const child = spawn(join(targetDir, 'release', name), [], {
      cwd: root,
      env: currentEnv,
      stdio: ['ignore', log, log],
      detached: true,
    });
    closeSync(log);
    return child;
  };
  const api = run('labos-threejs-api');
  const worker = run('labos-threejs-worker');
  await waitFor(`http://127.0.0.1:${apiPort}/health/ready`, api, 30_000);
  await waitFor(`http://127.0.0.1:${workerPort}/health/live`, worker, 30_000);
  console.log(
    `[stack] api on ${currentEnv.APP_BIND}, worker on ${currentEnv.WORKER_BIND}`,
  );

  return { env: currentEnv, apiPort, workerPort, children: { api, worker } };
}

export async function stopStack(children) {
  if (process.env.PERF_STACK_KEEP === '1') {
    console.log(
      `[stack] PERF_STACK_KEEP=1: the stack stays up. Tear it down with:\n` +
        `  docker compose -f compose.yaml -p ${project} down --volumes --remove-orphans`,
    );
    return;
  }
  if (children) {
    await stop(children.api, 10_000);
    await stop(children.worker, 15_000);
  }
  compose(['down', '--volumes', '--remove-orphans']);
  console.log('[stack] controlled stack torn down (volumes included).');
}
