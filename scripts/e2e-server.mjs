import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ServerProcess } from '../tests/support/server-process.ts';
import { CoreHttp } from '../tests/support/core-http.ts';
import { ContractResources } from './lib/contract-resources.mjs';
import { launch } from './lib/process.mjs';

// Linux browser supplement; the server's Linux/Windows gate remains independent.
if (process.platform !== 'linux')
  throw new Error('This owned browser supervisor currently supports Linux');
const backend = new ServerProcess(),
  web = new ServerProcess();
let resources, browser, closing;
async function close() {
  if (closing) return closing;
  if (resources) {
    resources.data.closing = true;
    resources.save();
  }
  closing = (async () => {
    if (browser?.pid) await resources.stop(browser.pid);
    await web.cleanup();
    await backend.cleanup();
    resources?.reconcile('browser-run-complete');
    resources?.snapshot('end');
  })();
  return closing;
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
  backend.env = {
    APP_ORIGIN: web.url,
    FILE_PUBLIC_ORIGIN: web.url,
    RATE_LIMIT_ENABLED: 'false',
  };
  await backend.start();
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
  await new CoreHttp(web.url).register('browser-owner@example.test');
  const intent = resources.planConsumer('playwright-desktop-process-group');
  browser = launch(
    'pnpm',
    ['exec', 'playwright', 'test', ...process.argv.slice(2)],
    {
      ...process.env,
      E2E_API_URL: backend.url,
      E2E_WEB_URL: web.url,
      LAB_NODE_EVIDENCE: backend.evidence,
      CONTRACT_RUN_ID: resources.data.runId,
      CONTRACT_CONSUMER_MARKER: intent.marker,
    },
  );
  resources.launchedConsumer(intent.id, browser.pid);
  resources.reconcile('before-browser');
  const [code] = await once(browser, 'exit');
  if (code !== 0)
    throw new Error(
      'Desktop browser checks failed; inspect the safe reporter and owned evidence',
    );
  resources.data.state = 'completed';
} catch (error) {
  if (resources) resources.data.state = 'failed';
  throw error;
} finally {
  await close();
  console.log(`Node browser evidence: ${backend.evidence}`);
}
