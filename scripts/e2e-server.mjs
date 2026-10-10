import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { watch } from 'node:fs';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { ServerProcess } from '../tests/support/server-process.ts';
import { CoreHttp } from '../tests/support/core-http.ts';
import { ContractResources } from './lib/contract-resources.mjs';
import { launch } from './lib/process.mjs';

// Linux browser supplement; the server's Linux/Windows gate remains independent.
if (process.platform !== 'linux')
  throw new Error('This owned browser supervisor currently supports Linux');
const backend = new ServerProcess(),
  web = new ServerProcess();
const args = process.argv.slice(2),
  production = process.env.E2E_WEB_MODE === 'production',
  statusControl = args.some((argument) => argument.includes('status.spec.ts')),
  reference = args.some((argument) =>
    argument.includes('lab-reference-load.spec.ts'),
  ),
  history = args.some((argument) => argument.includes('lab-history.spec.ts')),
  rate = args.some((argument) => argument.includes('rate-limits.spec.ts')),
  ownerEmail = 'bootstrap-owner@example.test',
  ownerPassword = 'browser-test-owner-password';
let resources, browser, closing, restarting, watcher;
let closed = false,
  failed = false;
async function startBackend() {
  if (closed) throw new Error('Browser supervisor is closing');
  await backend.start();
  const pidFile = join(backend.evidence, 'api.pid');
  await writeFile(pidFile + '.next', String(backend.child.pid) + '\n');
  await rename(pidFile + '.next', pidFile);
  backend.child.once('exit', (code, signal) => {
    if (closed) return;
    if (signal !== 'SIGKILL') {
      failed = true;
      void close();
      return;
    }
    const oldPid = backend.child.pid;
    restarting = (async () => {
      await backend.stop();
      if (closed) return;
      await startBackend();
      await appendFile(
        join(backend.evidence, 'restarts.jsonl'),
        JSON.stringify({
          event: 'owned.restart',
          oldPid,
          pid: backend.child.pid,
          classification: 'intentional-abrupt-recovery',
        }) + '\n',
      );
    })();
    restarting.catch(() => {
      failed = true;
      void close();
    });
  });
}
async function close() {
  if (closing) return closing;
  closed = true;
  watcher?.close();
  if (resources) {
    resources.data.closing = true;
    resources.save();
  }
  closing = (async () => {
    if (browser?.pid) await resources.stop(browser.pid);
    await backend.cleanup();
    await restarting?.catch(() => {});
    await web.cleanup();
    resources?.reconcile('browser-run-complete');
    resources?.snapshot('end');
  })();
  return closing;
}
async function recordProfileClosure() {
  if (process.env.LAB_NODE_BROWSER_PROFILE_RESULT) {
    const consumers = resources?.data.reconciliations.at(-1)?.consumers ?? [];
    if (
      consumers.some(
        (consumer) => consumer.alive || consumer.actualMembers.length,
      )
    )
      throw new Error('Browser cleanup has unclosed consumers');
    const serviceLedgers = resources?.data.serviceLedgers ?? [];
    for (const path of serviceLedgers) {
      const service = JSON.parse(await readFile(path, 'utf8'));
      if (
        service.state !== 'cleaned' ||
        service.directory ||
        service.processes?.length ||
        service.inProcessConsumers?.length ||
        service.launchIntent
      )
        throw new Error('Browser service cleanup is incomplete');
    }
    await writeFile(
      process.env.LAB_NODE_BROWSER_PROFILE_RESULT,
      JSON.stringify({
        cleanupCompleted: true,
        browserLedger: resources?.path ?? null,
        serviceLedgers,
      }) + '\n',
      { mode: 0o600 },
    );
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close();
  });
try {
  await backend.create();
  await web.create();
  resources = new ContractResources(
    join(backend.evidence, 'browser-owned-resources.json'),
    randomUUID(),
    false,
  );
  resources.data.owner = 'Node server desktop browser supervisor';
  resources.data.serviceLedgers = [
    join(backend.evidence, 'owned-resources.json'),
    join(web.evidence, 'owned-resources.json'),
  ];
  resources.save();
  resources.snapshot('start');
  const origin = production ? backend.url : web.url;
  backend.env = {
    APP_ORIGIN: origin,
    FILE_PUBLIC_ORIGIN: origin,
    LAB_WORD_WEB_DIR: '',
    RATE_LIMIT_ENABLED: rate ? 'true' : 'false',
    ...(history
      ? { LAB_OBSERVATION_RETENTION_SECS: '2', LAB_RECORD_RETENTION_SECS: '20' }
      : {}),
  };
  if (statusControl || reference) {
    backend.entry = 'tests/support/server-status-control.ts';
    backend.ipc = true;
  } else if (history) {
    backend.entry = 'tests/support/history-manual-cleanup-process.ts';
  }
  if (production) {
    web.entry = 'node_modules/vite/bin/vite.js';
    web.args = [
      'build',
      'apps/web',
      '--config',
      'apps/web/vite.config.ts',
      '--outDir',
      join(web.directory, 'web'),
    ];
    await web.spawn();
    await new Promise((resolve, reject) =>
      web.child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Owned production Web build failed')),
      ),
    );
    await web.stop();
    web.entry = 'scripts/build-server.mjs';
    web.args = ['--outDir', join(web.directory, 'server')];
    await web.spawn();
    await new Promise((resolve, reject) =>
      web.child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Owned production server build failed')),
      ),
    );
    await web.stop();
    if (!statusControl && !reference)
      backend.entry = join(web.directory, 'server/apps/server/src/main.js');
    backend.env.LAB_WORD_WEB_DIR = join(web.directory, 'web');
    web.port = backend.port;
    await web.startInProcess(
      'production static-directory consumer',
      startBackend,
      () => backend.cleanup(),
    );
  } else {
    await startBackend();
    web.entry = 'node_modules/vite/bin/vite.js';
    web.args = [
      'apps/web',
      '--config',
      'apps/web/vite.config.ts',
      '--host',
      '127.0.0.1',
    ];
    web.env = { WEB_PORT: String(web.port), VITE_API_PROXY: backend.url };
    await web.start();
  }
  const bootstrap = await new CoreHttp(origin).register(
    ownerEmail,
    ownerPassword,
  );
  if (bootstrap.user.role !== 'owner')
    throw new Error('Isolated browser Owner was not initialized');
  const controlFile = join(backend.evidence, 'service-control.json'),
    replyFile = join(backend.evidence, 'service-control-reply.json');
  if (statusControl || reference) {
    let handled = 0,
      controlling = Promise.resolve();
    await writeFile(controlFile, JSON.stringify({ revision: 0 }));
    watcher = watch(dirname(controlFile), (_event, name) => {
      if (String(name) !== basename(controlFile)) return;
      controlling = controlling.then(async () => {
        const request = JSON.parse(await readFile(controlFile, 'utf8'));
        if (closed || request.revision <= handled) return;
        handled = request.revision;
        let facts;
        if (request.action === 'inspect-store') {
          const acknowledged = once(backend.child, 'message');
          backend.child.send('inspect-store');
          const [message] = await acknowledged;
          if (message.event !== 'store.facts')
            throw new Error('Owned store inspection failed');
          facts = message.facts;
        } else if (request.action === 'close-store') {
          const acknowledged = once(backend.child, 'message');
          backend.child.send('close-store');
          const [message] = await acknowledged;
          if (message.event !== 'store.closed')
            throw new Error('Owned store close failed');
        } else if (request.action === 'restart-service') {
          backend.child.kill('SIGKILL');
          await once(backend.child, 'exit');
          await restarting;
        } else throw new Error('Unknown owned browser control');
        await writeFile(
          replyFile + '.next',
          JSON.stringify({ revision: handled, ...(facts ? { facts } : {}) }),
        );
        await rename(replyFile + '.next', replyFile);
      });
      controlling.catch(() => {
        failed = true;
        void close();
      });
    });
  }
  const intent = resources.planConsumer('playwright-desktop-process-group');
  browser = launch('pnpm', ['exec', 'playwright', 'test', ...args], {
    ...process.env,
    E2E_API_URL: backend.url,
    E2E_WEB_URL: origin,
    E2E_OWNER_EMAIL: ownerEmail,
    E2E_OWNER_PASSWORD: ownerPassword,
    E2E_API_PID_FILE: join(backend.evidence, 'api.pid'),
    E2E_SERVICE_CONTROL: statusControl || reference ? controlFile : '',
    E2E_SERVICE_CONTROL_REPLY: statusControl || reference ? replyFile : '',
    LAB_WORD_MIGRATION_DESKTOP:
      process.env.LAB_WORD_MIGRATION_DESKTOP ?? 'true',
    ...(history
      ? { LAB_OBSERVATION_RETENTION_SECS: '2', LAB_RECORD_RETENTION_SECS: '20' }
      : {}),
    LAB_NODE_EVIDENCE: backend.evidence,
    CONTRACT_RUN_ID: resources.data.runId,
    CONTRACT_CONSUMER_MARKER: intent.marker,
  });
  resources.launchedConsumer(intent.id, browser.pid);
  resources.reconcile('before-browser');
  const [code] = await once(browser, 'exit');
  if (code !== 0 || failed)
    throw new Error(
      'Desktop browser checks failed; inspect the safe reporter and owned evidence',
    );
  resources.data.state = 'completed';
} catch (error) {
  if (resources) {
    resources.data.state = 'failed';
    resources.save();
  }
  throw error;
} finally {
  await close();
  await recordProfileClosure();
  console.log(`Node browser evidence: ${backend.evidence}`);
}
