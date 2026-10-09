import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  busyDevPorts,
  devPortTargets,
  isPortListening,
  listeningPids,
  signalPid,
} from '../../scripts/lib/dev-ports.mjs';
import { freePort, launch, waitFor } from '../../scripts/lib/process.mjs';

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL('../..', import.meta.url));
const listenerFixture = fileURLToPath(
  new URL('./fixtures/listen-port.mjs', import.meta.url),
);

test('devPortTargets reads API/Worker binds and the web port', () => {
  assert.deepEqual(
    devPortTargets({
      APP_BIND: '127.0.0.1:3000',
      WORKER_BIND: '127.0.0.1:3001',
    }),
    [
      { name: 'API', host: '127.0.0.1', port: 3000 },
      { name: 'Worker', host: '127.0.0.1', port: 3001 },
      { name: 'Web', host: '127.0.0.1', port: 5173 },
    ],
  );
});

test('IPv6 development binds use a connectable host', async () => {
  const server = createServer((_request, response) => response.end('alive'));
  server.listen(0, '::1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const busy = await busyDevPorts({
      APP_BIND: `[::1]:${port}`,
      WEB_PORT: await freePort(),
    });
    assert.deepEqual(busy, [{ name: 'API', host: '::1', port }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Exercise the shipped CLI in an isolated project. The fake Vite entry is
// a real listener with the same cwd and executable shape as the dev server.
async function cliProject(t) {
  const project = await mkdtemp(join(tmpdir(), 'labword dev stop '));
  t.after(() => rm(project, { recursive: true, force: true }));
  const files = [
    'scripts/dev.mjs',
    'scripts/dev-stop.mjs',
    'scripts/lib/dev-ports.mjs',
    'scripts/lib/observability.mjs',
    'scripts/lib/process.mjs',
    'scripts/lib/development-mail-key.mjs',
  ];
  for (const file of files) {
    await mkdir(dirname(join(project, file)), { recursive: true });
    await copyFile(join(repository, file), join(project, file));
  }
  await writeFile(join(project, '.env.example'), '');
  await mkdir(join(project, 'apps/web'), { recursive: true });
  const vite = join(project, 'node_modules/vite/bin/vite.js');
  await mkdir(dirname(vite), { recursive: true });
  await copyFile(listenerFixture, vite);
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  return { project, vite };
}

async function listener(
  t,
  entry,
  cwd,
  ignoreTerm = false,
  executable = process.execPath,
) {
  const port = await freePort();
  const child = spawn(
    executable,
    [entry, String(port), ...(ignoreTerm ? ['--ignore-term'] : [])],
    { cwd, stdio: 'ignore' },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await exited;
  });
  await waitFor(`http://127.0.0.1:${port}`, child);
  return { child, port, exited };
}

async function devStop(project, webPort, overrides = {}) {
  const env = {
    ...process.env,
    APP_BIND: `127.0.0.1:${await freePort()}`,
    WORKER_BIND: `127.0.0.1:${await freePort()}`,
    WEB_PORT: String(webPort),
    ...overrides,
  };
  try {
    const result = await execFileAsync(
      process.execPath,
      [join(project, 'scripts/dev-stop.mjs')],
      { cwd: project, env, timeout: 15_000 },
    );
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return error;
  }
}

test(
  'dev-stop recognizes API and Worker executables only in this worktree',
  { skip: !['linux', 'darwin'].includes(process.platform) },
  async (t) => {
    const { project } = await cliProject(t);
    for (const [binary, bind] of [
      ['labos-threejs-api', 'APP_BIND'],
      ['labos-threejs-worker', 'WORKER_BIND'],
    ]) {
      const executable = join(project, binary);
      // A separate executable name models the native dev binary without
      // building Rust or starting services. Hard links avoid copying Node.
      try {
        await link(process.execPath, executable);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await copyFile(process.execPath, executable);
      }
      for (const cwd of [project, tmpdir()]) {
        const { child, port, exited } = await listener(
          t,
          listenerFixture,
          cwd,
          false,
          executable,
        );
        const result = await devStop(project, await freePort(), {
          [bind]: `127.0.0.1:${port}`,
        });
        if (cwd === project) {
          assert.equal(result.code, 0, result.stderr);
          assert.equal(await isPortListening('127.0.0.1', port), false);
          await exited;
          assert.equal(child.exitCode, 0);
        } else {
          assert.equal(await isPortListening('127.0.0.1', port), true);
          assert.equal(result.code, 1);
          assert.match(result.stderr, /left untouched/);
        }
      }
    }
  },
);

for (const ignoreTerm of [false, true]) {
  test(
    `dev-stop stops this worktree's Vite with ${ignoreTerm ? 'SIGKILL after ignored TERM' : 'TERM'}`,
    { skip: !['linux', 'darwin'].includes(process.platform) },
    async (t) => {
      const { project, vite } = await cliProject(t);
      const { child, port, exited } = await listener(
        t,
        vite,
        join(project, 'apps/web'),
        ignoreTerm,
      );
      const result = await devStop(project, port);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await isPortListening('127.0.0.1', port), false);
      await exited;
      if (ignoreTerm) assert.equal(child.signalCode, 'SIGKILL');
      else assert.equal(child.exitCode, 0);
    },
  );
}

test(
  'dev-stop preserves another project Vite and an unrelated local process',
  { skip: !['linux', 'darwin'].includes(process.platform) },
  async (t) => {
    const { project, vite } = await cliProject(t);
    for (const [entry, cwd] of [
      [vite, tmpdir()],
      [listenerFixture, join(project, 'apps/web')],
    ]) {
      const { port } = await listener(t, entry, cwd);
      const result = await devStop(project, port);
      assert.equal(await isPortListening('127.0.0.1', port), true);
      assert.equal(result.code, 1);
      assert.match(`${result.stdout}${result.stderr}`, /left untouched/);
    }
  },
);

test('dev preflight reports a busy port before starting data services', async (t) => {
  const { project } = await cliProject(t);
  const { port } = await listener(t, listenerFixture, project);
  await assert.rejects(
    execFileAsync(process.execPath, [join(project, 'scripts/dev.mjs')], {
      cwd: project,
      env: {
        ...process.env,
        // No external commands are available: the preflight must finish
        // before Docker, migrations or any application process can start.
        PATH: '',
        APP_BIND: `127.0.0.1:${port}`,
        WORKER_BIND: `127.0.0.1:${await freePort()}`,
        WEB_PORT: String(await freePort()),
      },
      timeout: 5_000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        new RegExp(`Dev ports already in use: API ${port}`),
      );
      assert.match(error.stderr, /just dev-stop/);
      assert.doesNotMatch(error.stderr, /ENOENT/);
      return true;
    },
  );
  assert.equal(await isPortListening('127.0.0.1', port), true);
});

test('isPortListening tracks a server lifecycle', async () => {
  const port = await freePort();
  assert.equal(await isPortListening('127.0.0.1', port), false);
  const server = createServer((_request, response) =>
    response.end('alive'),
  ).listen(port, '127.0.0.1');
  await once(server, 'listening');
  assert.equal(await isPortListening('127.0.0.1', port), true);
  server.close();
  await once(server, 'close');
  assert.equal(await isPortListening('127.0.0.1', port), false);
});

test(
  'busyDevPorts and listeningPids find a real listener; signalPid stops it',
  { skip: process.platform === 'win32' },
  async (t) => {
    const [quietWorker, quietWeb] = [await freePort(), await freePort()];
    const live = await freePort();
    const child = launch(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/listen-port.mjs', import.meta.url)),
        String(live),
      ],
      process.env,
    );
    t.after(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
    await waitFor(`http://127.0.0.1:${live}`, child);

    assert.deepEqual(
      await busyDevPorts({
        APP_BIND: `127.0.0.1:${live}`,
        WORKER_BIND: `127.0.0.1:${quietWorker}`,
        WEB_PORT: quietWeb,
      }),
      [{ name: 'API', host: '127.0.0.1', port: live }],
    );

    const byPort = await listeningPids([live, quietWorker]);
    assert.ok(byPort.get(live).has(child.pid));
    assert.equal(byPort.get(quietWorker).size, 0);

    signalPid(child.pid, 'SIGTERM');
    const deadline = performance.now() + 5_000;
    while (
      (await isPortListening('127.0.0.1', live)) &&
      performance.now() < deadline
    ) {
      await delay(50);
    }
    assert.equal(await isPortListening('127.0.0.1', live), false);
  },
);
