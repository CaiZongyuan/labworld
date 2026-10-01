import { withTestServices } from './lib/test-services.mjs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { freePort, launch, root, run, stop, waitFor } from './lib/process.mjs';

// Remove legacy HTML reports that can contain authentication action arguments.
rmSync(resolve(root, 'playwright-report'), { recursive: true, force: true });

run('cargo', ['build', '--locked', '--workspace', '--bins'], {
  ...process.env,
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
});
await withTestServices(async ({ postgresName, storageName, env: services }) => {
  const apiPort = await freePort();
  const webPort = await freePort();
  const workerPort = await freePort();
  const env = {
    ...process.env,
    ...services,
    TELEMETRY_ENDPOINT: '',
    TELEMETRY_LOG_DIRECTORY: '',
    CACHE_PREFIX: `e2e:${postgresName}`,
    APP_BIND: `127.0.0.1:${apiPort}`,
    WORKER_BIND: `127.0.0.1:${workerPort}`,
    RUST_LOG: 'info',
    VITE_API_PROXY: `http://127.0.0.1:${apiPort}`,
    WEB_PORT: String(webPort),
    E2E_API_URL: `http://127.0.0.1:${apiPort}`,
    E2E_WEB_URL: `http://127.0.0.1:${webPort}`,
    APP_ORIGIN: `http://127.0.0.1:${webPort}`,
    TEST_PG_CONTAINER: postgresName,
    E2E_STORAGE_CONTAINER: storageName,
    // Short, finite budgets make isolated recovery scenarios observable.
    JOB_LEASE_SECS: '10',
    JOB_HEARTBEAT_SECS: '2',
    JOB_SHUTDOWN_SECS: '1',
    // example:knowledge:e2e-policy:start
    EXPORT_TIMEOUT_SECS: '5',
    EXPORT_JOB_MAX_ATTEMPTS: '2',
    // example:knowledge:e2e-policy:end
    E2E_OWNER_EMAIL: 'bootstrap-owner@example.test',
    E2E_OWNER_PASSWORD: 'browser-test-owner-password',
  };
  run(resolve(root, 'target/debug/migrate'), [], env);
  run(resolve(root, 'target/debug/bootstrap-storage'), [], env);
  const api = launch(resolve(root, 'target/debug/labos-threejs-api'), [], env);
  const workerTemp = mkdtempSync(join(tmpdir(), 'labos-threejs-e2e-worker-'));
  env.TMPDIR = workerTemp;
  env.E2E_WORKER_PID_FILE = join(workerTemp, 'worker.pid');
  const worker = launch('node', ['scripts/lib/test-worker.mjs'], env);
  let web;
  try {
    await waitFor(`${env.E2E_API_URL}/health/ready`, api);
    await waitFor(`http://${env.WORKER_BIND}/health/ready`, worker);
    // All journeys start with a known Owner; newly registered accounts are Members.
    // This prevents test-file ordering from changing role expectations.
    const bootstrap = await fetch(`${env.E2E_API_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env.APP_ORIGIN,
      },
      body: JSON.stringify({
        email: env.E2E_OWNER_EMAIL,
        password: env.E2E_OWNER_PASSWORD,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (
      bootstrap.status !== 201 ||
      (await bootstrap.json()).user.role !== 'owner'
    )
      throw new Error('Could not initialize the isolated E2E Owner');
    web = launch('pnpm', ['--filter', '@labos-threejs/web', 'dev'], env);
    await waitFor(env.E2E_WEB_URL, web);
    run('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], env);
  } finally {
    await Promise.all([
      stop(web),
      stop(api),
      stop(worker, (Number(env.JOB_SHUTDOWN_SECS ?? 10) + 3) * 1000),
    ]);
    rmSync(workerTemp, { recursive: true, force: true });
  }
});
