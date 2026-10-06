import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { configuration } from '../apps/server/src/config.ts';
import {
  processIdentity,
  type DevelopmentLedger,
} from '../tests/support/server-resources.ts';
const config = configuration();
const root = resolve('.');
const marker = `lab-word-dev-${randomUUID()}`;
const evidence = join(root, '.scratch', 'vnext-m1', marker);
await mkdir(evidence, { recursive: true });
const children: ChildProcess[] = [];
let closing = false;
const creator = await processIdentity(process.pid);
if (!creator) throw new Error('Development creator identity is unavailable');
const launchIntents: DevelopmentLedger['launchIntents'] = [
  { role: 'server', state: 'planned' },
  { role: 'web', state: 'planned' },
];
const ledgerPath = join(evidence, 'owned-resources.json');
let proofs: DevelopmentLedger['processes'] = [];
function writeLedger() {
  writeFileSync(
    ledgerPath,
    JSON.stringify(
      {
        owner: 'Lab Word development supervisor',
        creator,
        marker,
        directory: config.directory,
        dataPurpose: 'persistent local development data; retained on shutdown',
        port: config.port,
        webPort: Number(process.env.WEB_PORT ?? 5173),
        processes: proofs,
        launchIntents,
        docker: [],
        state: closing ? 'stopped' : 'running',
      },
      null,
      2,
    ),
  );
}
async function record() {
  proofs = (
    await Promise.all(
      children
        .filter(
          (child) =>
            child.pid && child.exitCode === null && child.signalCode === null,
        )
        .map((child) => processIdentity(child.pid!)),
    )
  ).filter((proof): proof is NonNullable<typeof proof> => Boolean(proof));
  writeLedger();
}

function launch(
  role: 'server' | 'web',
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(process.execPath, [`--title=${marker}`, ...args], {
    cwd,
    env,
    stdio: 'inherit',
  });
  children.push(child);
  const intent = launchIntents.find((intent) => intent.role === role)!;
  intent.pid = child.pid;
  intent.state = 'launched';
  writeLedger();
  child.once('error', (error) => {
    console.error(error.message);
    void close(1);
  });
  child.once('exit', () => {
    if (!closing) void close(1);
  });
  return child;
}
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(deadline);
    }),
  );
  await record();
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void close();
  });
await record();
console.log(
  JSON.stringify({
    event: 'development.ownership',
    ledger: ledgerPath,
    marker,
  }),
);
launch(
  'server',
  ['--experimental-strip-types', 'apps/server/src/main.ts'],
  root,
  process.env,
);
await record();
const deadline = Date.now() + 30000;
while (!closing && Date.now() < deadline) {
  try {
    if (
      (
        await fetch(`http://${config.hostname}:${config.port}/health/ready`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok
    )
      break;
  } catch {
    // The owned server is still starting; retry within the bounded deadline.
  }
  await new Promise((r) => setTimeout(r, 50));
}
if (!closing) {
  const ready = await fetch(
    `http://${config.hostname}:${config.port}/health/ready`,
  ).catch(() => undefined);
  if (!ready?.ok) {
    console.error('Lab Word Server did not become ready');
    await close(1);
  } else {
    launch(
      'web',
      [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'],
      join(root, 'apps/web'),
      {
        ...process.env,
        VITE_API_PROXY: `http://${config.hostname}:${config.port}`,
      },
    );
    // Test-only failure boundary: emulate the Windows async-CIM proof gap.
    if (process.env.LAB_WORD_TEST_DEV_HOLD_FINAL_PROOF === '1')
      await new Promise<void>(() => {});
    await record();
    console.log(
      `Lab Word: http://127.0.0.1:${process.env.WEB_PORT ?? 5173}; Platform Core is available; Lab endpoints are pending migration.`,
    );
  }
}
