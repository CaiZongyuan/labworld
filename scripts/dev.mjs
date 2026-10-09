import { observabilityEnv, startObservability } from './lib/observability.mjs';
import { busyDevPorts } from './lib/dev-ports.mjs';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { developmentEnv, launch, root, run, stop } from './lib/process.mjs';

const observing = process.argv.includes('--observability');
const env = observing ? observabilityEnv(developmentEnv()) : developmentEnv();
const busy = await busyDevPorts(env);
if (busy.length > 0) {
  const webPort = env.WEB_PORT ?? 5173;
  console.error(
    [
      `Dev ports already in use: ${busy.map(({ name, port }) => `${name} ${port}`).join(', ')}.`,
      '',
      'A dev stack may already be running:',
      `  1. Open http://127.0.0.1:${webPort}/ — if it loads, keep using it; nothing to restart.`,
      '  2. Otherwise run `just dev-stop` to stop leftovers from an earlier run, then `just dev` again.',
      `  3. If both fail, another program owns the ports — inspect with \`ss -tlnp | grep -E '(:${busy.map(({ port }) => port).join('|')})\\b'\`.`,
    ].join('\n'),
  );
  process.exit(1);
}
if (observing) await startObservability(env);
run(
  'docker',
  ['compose', 'up', '-d', '--wait', 'postgres', 'rustfs', 'redis', 'mailpit'],
  env,
);
run(
  'cargo',
  ['run', '--locked', '-p', 'labos-threejs-api', '--bin', 'migrate'],
  env,
);
run(
  'cargo',
  ['run', '--locked', '-p', 'labos-threejs-api', '--bin', 'bootstrap-storage'],
  env,
);
let api = launch(
  'cargo',
  ['run', '--locked', '-p', 'labos-threejs-api', '--bin', 'labos-threejs-api'],
  env,
);
let worker = launch(
  'cargo',
  ['run', '--locked', '-p', 'labos-threejs-worker'],
  env,
);
const telemetryGrace = env.TELEMETRY_ENDPOINT ? 10_000 : 1500;
const apiGrace = 5000 + telemetryGrace;
const workerGrace =
  (Number(env.JOB_SHUTDOWN_SECS ?? 10) + 3) * 1000 + telemetryGrace;
const web = launch('pnpm', ['--filter', '@labos-threejs/web', 'dev'], env);
let closing = false;
let restarting = false;
let changed = false;
let debounce;

async function restartRust() {
  changed = true;
  if (restarting || closing) return;
  restarting = true;
  while (changed && !closing) {
    changed = false;
    await Promise.all([stop(api, apiGrace), stop(worker, workerGrace)]);
    if (!closing) {
      worker = launch(
        'cargo',
        ['run', '--locked', '-p', 'labos-threejs-worker'],
        env,
      );
      api = launch(
        'cargo',
        [
          'run',
          '--locked',
          '-p',
          'labos-threejs-api',
          '--bin',
          'labos-threejs-api',
        ],
        env,
      );
    }
  }
  restarting = false;
}
const watchers = ['crates', 'apps/api', 'apps/worker'].map((directory) =>
  watch(join(root, directory), { recursive: true }, (_event, name) => {
    if (!name || !/\.(rs|toml)$/.test(name)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void restartRust();
    }, 150);
  }),
);

async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(debounce);
  watchers.forEach((watcher) => watcher.close());
  await Promise.all([
    stop(api, apiGrace),
    stop(worker, workerGrace),
    stop(web),
  ]);
  console.log(
    'API, Worker and Web stopped. Data is preserved; use just services-down to stop PostgreSQL/RustFS/Redis/Mailpit.',
  );
}
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
web.once('exit', () => {
  if (!closing) void close();
});
console.log(
  `Web: http://127.0.0.1:${env.WEB_PORT ?? 5173} | API: http://${env.APP_BIND} | Worker: http://${env.WORKER_BIND} | mail: http://127.0.0.1:${env.MAILPIT_HTTP_PORT ?? 8025} | docs: just docs`,
);
