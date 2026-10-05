import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { withTestServices } from './lib/test-services.mjs';
import { freePort, launch, root, stop, waitFor } from './lib/process.mjs';
import { ContractResources } from './lib/contract-resources.mjs';

const { values, positionals } = parseArgs({
  options: {
    target: { type: 'string', default: 'rust' },
    descriptor: { type: 'string' },
    recover: { type: 'string' },
    'no-build': { type: 'boolean' },
    timeout: { type: 'string', default: '900' },
    profile: { type: 'string', default: 'baseline' },
  },
  allowPositionals: true,
});
if (values.recover) {
  const resource = new ContractResources(resolve(values.recover));
  await resource.recover((pid) =>
    stop({ pid, exitCode: null, signalCode: null, once: () => {} }),
  );
} else {
  const rust = values.target === 'rust';
  if (!rust && !values.descriptor)
    throw new Error(
      'The new service does not exist; provide an executable descriptor to select another target',
    );
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, '.scratch/vnext-m0/runs', runId);
  mkdirSync(resolve(directory, 'data'), { recursive: true });
  const resource = new ContractResources(
    resolve(directory, 'owned-resources.json'),
    runId,
    rust,
  );
  const targetDirectory = resolve(
    root,
    process.env.CARGO_TARGET_DIR ?? '.scratch/vnext-m0/target',
  );
  const children = [];
  async function controlled(command, args, env, role) {
    const child = launch(command, args, env);
    children.push(child);
    resource.consumer(child.pid, role);
    const exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    await stop(child);
    if (exit !== 0) throw new Error(`${role} exited ${exit}`);
  }
  let closing;
  async function close() {
    closing ??= (async () => {
      await Promise.all(children.map((child) => stop(child)));
      resource.reconcile('before-cleanup');
      for (const container of resource.data.containers)
        resource.remove(container.name);
    })();
    return closing;
  }
  const interrupted = async () => {
    try {
      await close();
      resource.data.state = 'interrupted';
      resource.snapshot('interrupted-end');
    } finally {
      process.exit(130);
    }
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const timeout = setTimeout(interrupted, Number(values.timeout) * 1000);
  try {
    resource.snapshot('start');
    writeFileSync(
      resolve(root, '.scratch/vnext-m0/current.json'),
      JSON.stringify(
        {
          runId,
          directory,
          target: values.target,
          profile: values.profile,
          ledger: resource.path,
          baseline: '8bc9c3fa941c2b4c984d891ea0aa2716c701d594',
        },
        null,
        2,
      ) + '\n',
    );
    if (rust && !values['no-build'])
      await controlled(
        'cargo',
        ['build', '--locked', '--workspace', '--bins'],
        {
          ...process.env,
          CARGO_TARGET_DIR: targetDirectory,
          CARGO_BUILD_JOBS: '4',
        },
        'cargo-process-group',
      );
    async function exercise({ env: services }) {
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const descriptor = values.descriptor
        ? JSON.parse(readFileSync(resolve(values.descriptor), 'utf8'))
        : { command: resolve(targetDirectory, 'debug/labos-threejs-api') };
      const descriptorPath = resolve(directory, 'target.json');
      writeFileSync(descriptorPath, JSON.stringify(descriptor));
      const env = {
        ...process.env,
        ...services,
        APP_BIND: `127.0.0.1:${port}`,
        APP_ORIGIN: origin,
        TELEMETRY_ENDPOINT: '',
        TELEMETRY_LOG_DIRECTORY: '',
        CACHE_PREFIX: `contract:${runId}`,
        RATE_LIMIT_PREFIX: `contract:${runId}`,
        CONTRACT_URL: origin,
        CONTRACT_ORIGIN: origin,
        CONTRACT_TARGET: values.target,
        CONTRACT_PROFILE: values.profile,
        CONTRACT_DATA_DIRECTORY: resolve(directory, 'data'),
        CONTRACT_API_PID_FILE: resolve(directory, 'api.pid'),
        CONTRACT_TARGET_DESCRIPTOR: descriptorPath,
        CONTRACT_REPORT: resolve(directory, 'results.json'),
        CONTRACT_OWNER_EMAIL: 'contract-owner@example.test',
        CONTRACT_OWNER_PASSWORD: 'contract-isolated-password',
        RUST_LOG: 'warn',
      };
      if (values.profile === 'capacity') env.RATE_LIMIT_ENABLED = 'false';
      if (values.profile === 'retention') {
        env.LAB_OBSERVATION_RETENTION_SECS = '2';
        env.LAB_RECORD_RETENTION_SECS = '3';
      }
      if (values.profile === 'rate') env.RATE_LIMIT_WINDOW_SECS = '2';
      try {
        if (rust) {
          await controlled(
            resolve(targetDirectory, 'debug/migrate'),
            [],
            env,
            'migration-process-group',
          );
          await controlled(
            resolve(targetDirectory, 'debug/bootstrap-storage'),
            [],
            env,
            'storage-bootstrap-process-group',
          );
          const workerPort = await freePort();
          const worker = launch(
            resolve(targetDirectory, 'debug/labos-threejs-worker'),
            [],
            {
              ...env,
              WORKER_BIND: `127.0.0.1:${workerPort}`,
              JOB_MAINTENANCE_SECS: '1',
              JOB_SHUTDOWN_SECS: '1',
            },
          );
          children.push(worker);
          resource.consumer(worker.pid, 'file-cleanup-worker-process-group');
          await waitFor(`http://127.0.0.1:${workerPort}/health/ready`, worker);
        }
        const api = launch('node', ['scripts/lib/contract-target.mjs'], env);
        children.push(api);
        resource.consumer(api.pid, 'target-process-group');
        await waitFor(`${origin}/health/ready`, api);
        const bootstrap = await fetch(`${origin}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({
            email: env.CONTRACT_OWNER_EMAIL,
            password: env.CONTRACT_OWNER_PASSWORD,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (
          bootstrap.status !== 201 ||
          (await bootstrap.json()).user.role !== 'owner'
        )
          throw new Error('Could not initialize isolated Owner through HTTP');
        resource.reconcile('before-tests');
        await controlled(
          'pnpm',
          [
            'exec',
            'vitest',
            'run',
            '--config',
            'vitest.contract.config.ts',
            ...positionals,
          ],
          env,
          'vitest-process-group',
        );
      } finally {
        await Promise.all(children.map((child) => stop(child)));
      }
    }
    if (rust) await withTestServices(exercise, { resource });
    else await exercise({ env: {} });
    resource.data.state = 'completed';
  } catch (error) {
    resource.data.state = 'failed';
    throw error;
  } finally {
    clearTimeout(timeout);
    await close();
    resource.snapshot('end');
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    console.log(`Contract evidence: ${directory}`);
  }
}
