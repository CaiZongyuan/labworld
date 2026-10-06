import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { configuration } from '../apps/server/src/config.ts';
import { processIdentity } from '../tests/support/server-resources.ts';
const config = configuration();
const root = resolve('.');
const marker = `lab-word-dev-${randomUUID()}`;
const evidence = join(root, '.scratch', 'vnext-m1', marker);
await mkdir(evidence, { recursive: true });
const children: ChildProcess[] = [];
let closing = false;
async function record() {
  await writeFile(
    join(evidence, 'owned-resources.json'),
    JSON.stringify(
      {
        owner: 'Lab Word development supervisor',
        creator: await processIdentity(process.pid),
        marker,
        directory: config.directory,
        dataPurpose: 'persistent local development data; retained on shutdown',
        port: config.port,
        webPort: Number(process.env.WEB_PORT ?? 5173),
        processes: await Promise.all(
          children
            .filter(
              (c) => c.pid && c.exitCode === null && c.signalCode === null,
            )
            .map((c) => processIdentity(c.pid!)),
        ),
        docker: [],
        state: closing ? 'stopped' : 'running',
      },
      null,
      2,
    ),
  );
}
function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [`--title=${marker}`, ...args], {
    cwd,
    env,
    stdio: 'inherit',
  });
  children.push(child);
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
launch(
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
      [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'],
      join(root, 'apps/web'),
      {
        ...process.env,
        VITE_API_PROXY: `http://${config.hostname}:${config.port}`,
      },
    );
    await record();
    console.log(
      `M1 foundation: http://127.0.0.1:${process.env.WEB_PORT ?? 5173}; identity and Lab endpoints are pending migration.`,
    );
  }
}
