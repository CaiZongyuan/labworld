import { withTestServices } from './lib/test-services.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { freePort, launch, root, run, stop, waitFor } from './lib/process.mjs';

// The disposable desktop stack shared by the shell commands (smoke, soak):
// test-flavored PostgreSQL, RustFS, Redis and Mailpit as one-off containers,
// API and Web dev server on free ports, a one-off downloads directory — all
// of it destroyed when the body returns, so a run never touches development
// data. Builds happen before the stack comes up; an optional seed hook runs
// against the API once it is ready and before the Web server starts, which
// is where both commands sign users in and provision documents. runDesktopTests
// bootstraps Electron (its binary downloads lazily on first require, which
// must not race a test launch) and forks Playwright under the display or a
// fresh xvfb server, whichever this machine has.

export async function withDesktopStack(
  { cachePrefix, extraEnv = {}, seed },
  body,
) {
  run('cargo', ['build', '--locked', '--workspace', '--bins'], {
    ...process.env,
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
  });
  run('pnpm', ['--filter', '@labos-threejs/desktop', 'build']);
  await withTestServices(
    async ({ postgresName, storageName, env: services }) => {
      const apiPort = await freePort();
      const webPort = await freePort();
      const downloadsDir = mkdtempSync(join(tmpdir(), 'labos-threejs-desktop-dl-'));
      const webOrigin = `http://127.0.0.1:${webPort}`;
      const env = {
        ...process.env,
        ...services,
        TELEMETRY_ENDPOINT: '',
        TELEMETRY_LOG_DIRECTORY: '',
        CACHE_PREFIX: `${cachePrefix}:${postgresName}`,
        APP_BIND: `127.0.0.1:${apiPort}`,
        RUST_LOG: 'info',
        VITE_API_PROXY: `http://127.0.0.1:${apiPort}`,
        WEB_PORT: String(webPort),
        E2E_API_URL: `http://127.0.0.1:${apiPort}`,
        E2E_WEB_URL: webOrigin,
        APP_ORIGIN: webOrigin,
        TEST_PG_CONTAINER: postgresName,
        E2E_STORAGE_CONTAINER: storageName,
        ...extraEnv,
      };
      let api;
      let web;
      try {
        run(resolve(root, 'target/debug/migrate'), [], env);
        run(resolve(root, 'target/debug/bootstrap-storage'), [], env);
        api = launch(resolve(root, 'target/debug/labos-threejs-api'), [], env);
        await waitFor(`${env.E2E_API_URL}/health/ready`, api);
        if (seed) await seed({ env, webOrigin });
        web = launch('pnpm', ['--filter', '@labos-threejs/web', 'dev'], env);
        await waitFor(env.E2E_WEB_URL, web);
        await body({ env, webOrigin, downloadsDir });
      } finally {
        await Promise.all([stop(web), stop(api)]);
        rmSync(downloadsDir, { recursive: true, force: true });
      }
    },
  );
}

function displayAvailable() {
  return Boolean(process.env.DISPLAY);
}

export function runDesktopTests(specEnv, config) {
  // Electron 44 downloads its binary lazily on first require; do it once
  // here so test launches never race the download (ETXTBSY).
  const requireElectron = createRequire(
    join(root, 'apps/desktop/package.json'),
  );
  run('node', [
    '-e',
    `require(${JSON.stringify(requireElectron.resolve('electron'))});`,
  ]);
  const playwrightArgs = ['exec', 'playwright', 'test', '--config', config];
  if (displayAvailable()) {
    run('pnpm', playwrightArgs, specEnv);
  } else {
    // xvfb-run computes and exports a fresh display for the shell.
    run('xvfb-run', ['--auto-servernum', 'pnpm', ...playwrightArgs], specEnv);
  }
}
