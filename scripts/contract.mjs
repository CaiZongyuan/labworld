import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { withTestServices } from './lib/test-services.mjs';
import { freePort, launch, root, run, stop, waitFor } from './lib/process.mjs';
import { ContractResources } from './lib/contract-resources.mjs';

const { values, positionals } = parseArgs({
  options: {
    target: { type: 'string', default: 'rust' },
    descriptor: { type: 'string' },
    recover: { type: 'string' },
    'no-build': { type: 'boolean' },
    timeout: { type: 'string', default: '900' },
  },
  allowPositionals: true,
  strict: false,
});
if (values.recover) {
  const resource = new ContractResources(resolve(values.recover));
  await resource.recover((pid) =>
    stop({ pid, exitCode: null, signalCode: null, once: () => {} }),
  );
} else {
  if (values.target !== 'rust' && !values.descriptor)
    throw new Error(
      'The new service does not exist; provide an executable descriptor to select another target',
    );
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, '.scratch/vnext-m0/runs', runId);
  mkdirSync(resolve(directory, 'data'), { recursive: true });
  const resource = new ContractResources(
    resolve(directory, 'owned-resources.json'),
    runId,
  );
  const targetDirectory = resolve(
    root,
    process.env.CARGO_TARGET_DIR ?? '.scratch/vnext-m0/target',
  );
  const children = [];
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
          ledger: resource.path,
          baseline: '8bc9c3fa941c2b4c984d891ea0aa2716c701d594',
        },
        null,
        2,
      ) + '\n',
    );
    if (values.target === 'rust' && !values['no-build'])
      run('cargo', ['build', '--locked', '--workspace', '--bins'], {
        ...process.env,
        CARGO_TARGET_DIR: targetDirectory,
        CARGO_BUILD_JOBS: '4',
      });
    await withTestServices(
      async ({ env: services, postgresName }) => {
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
          CONTRACT_DATA_DIRECTORY: resolve(directory, 'data'),
          CONTRACT_API_PID_FILE: resolve(directory, 'api.pid'),
          CONTRACT_TARGET_DESCRIPTOR: descriptorPath,
          CONTRACT_REPORT: resolve(directory, 'results.json'),
          CONTRACT_PG_CONTAINER: postgresName,
          RUST_LOG: 'warn',
        };
        if (values.target === 'rust') {
          run(resolve(targetDirectory, 'debug/migrate'), [], env);
          run(resolve(targetDirectory, 'debug/bootstrap-storage'), [], env);
        }
        try {
          const api = launch('node', ['scripts/lib/contract-target.mjs'], env);
          children.push(api);
          resource.consumer(api.pid, 'target-process-group');
          await waitFor(`${origin}/health/ready`, api);
          resource.reconcile('before-tests');
          const tests = launch(
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
          );
          children.push(tests);
          resource.consumer(tests.pid, 'vitest-process-group');
          const exit = await new Promise((resolveExit, reject) => {
            tests.once('error', reject);
            tests.once('exit', resolveExit);
          });
          if (exit !== 0) throw new Error(`Contract tests exited ${exit}`);
        } finally {
          await Promise.all(children.map((child) => stop(child)));
        }
      },
      { resource },
    );
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
