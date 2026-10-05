import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { withTestServices } from './lib/test-services.mjs';
import { freePort, launch, root, waitFor } from './lib/process.mjs';
import { ContractResources } from './lib/contract-resources.mjs';

const { values, positionals } = parseArgs({
  options: {
    target: { type: 'string', default: 'rust' },
    descriptor: { type: 'string' },
    recover: { type: 'string' },
    'no-build': { type: 'boolean' },
    timeout: { type: 'string', default: '900' },
    profile: { type: 'string', default: 'baseline' },
    'lifecycle-probe': { type: 'boolean' },
    'lifecycle-barrier': { type: 'string' },
    'no-process-sampler': { type: 'boolean' },
    'run-id': { type: 'string' },
  },
  allowPositionals: true,
});
if (values.recover) {
  const resource = new ContractResources(resolve(values.recover));
  await resource.recover();
} else {
  const rust = values.target === 'rust';
  if (process.platform !== 'linux')
    throw new Error(
      'M0 controlled targets run on Linux; the Windows adapter is pending',
    );
  if (!rust && !values.descriptor)
    throw new Error(
      'The new service does not exist; provide an executable descriptor to select another target',
    );
  const runId = values['run-id'] ?? `${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9-]+$/.test(runId))
    throw new Error('Use a simple unique run id');
  const directory = resolve(root, '.scratch/vnext-m0/runs', runId);
  if (existsSync(directory))
    throw new Error(
      'Run directory already exists; use a new id or recover the original ledger',
    );
  mkdirSync(resolve(directory, 'data'), { recursive: true });
  const proofJournal = resolve(directory, 'target-process-proof.jsonl');
  writeFileSync(proofJournal, '', { mode: 0o600 });
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
  function assertOpen() {
    if (resource.data.closing)
      throw new Error(
        'Contract supervisor cancelled; no more consumers may start',
      );
  }
  function spawnOwned(command, args, env, role) {
    assertOpen();
    const child = launch(command, args, env);
    if (!child.pid) throw new Error(`Could not start ${role}`);
    children.push(child);
    resource.consumer(
      child.pid,
      role,
      role === 'target-process-group' ? proofJournal : undefined,
    );
    return child;
  }
  const stopOwned = (child) => resource.stop(child.pid);
  async function controlled(command, args, env, role) {
    const child = spawnOwned(command, args, env, role);
    const exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    await stopOwned(child);
    if (exit !== 0) throw new Error(`${role} exited ${exit}`);
  }
  let closing;
  async function close() {
    closing ??= (async () => {
      resource.data.closing = true;
      resource.save();
      const stopped = await Promise.allSettled(children.map(stopOwned));
      resource.reconcile('before-cleanup');
      const failures = stopped.filter((result) => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Some consumer identities could not be stopped safely; resources retained',
        );
      for (const container of resource.data.containers)
        resource.remove(container.name);
    })();
    return closing;
  }
  const interrupted = async () => {
    try {
      await close();
      resource.data.state = 'interrupted';
    } catch (error) {
      resource.data.state = 'cleanup-failed';
      console.error(error.message);
    } finally {
      resource.snapshot('interrupted-end');
      process.exit(130);
    }
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const observer = setInterval(() => {
    if (!resource.data.closing && !values['no-process-sampler'])
      resource.sampleConsumers();
  }, 500);
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
        CONTRACT_LEDGER_PATH: resource.path,
        CONTRACT_RUN_ID: runId,
        CONTRACT_PROCESS_PROOF_JOURNAL: proofJournal,
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
      if (rust) {
        env.CONTRACT_EXPECTED_VERSION = readFileSync(
          resolve(root, 'Cargo.toml'),
          'utf8',
        ).match(/\[workspace.package\][\s\S]*?version = "([^"]+)"/)[1];
        env.CONTRACT_EXPECTED_SCHEMA = String(
          Math.max(
            ...readdirSync(resolve(root, 'migrations'))
              .filter((name) => /^\d+.*\.sql$/.test(name))
              .map((name) => Number(name.split('_')[0])),
          ),
        );
      } else {
        if (descriptor.version !== undefined)
          env.CONTRACT_EXPECTED_VERSION = String(descriptor.version);
        if (descriptor.schemaVersion !== undefined)
          env.CONTRACT_EXPECTED_SCHEMA = String(descriptor.schemaVersion);
      }
      if (values.profile === 'capacity') env.RATE_LIMIT_ENABLED = 'false';
      if (values.profile === 'session-ttl') {
        env.SESSION_ABSOLUTE_SECS = '5';
        env.SESSION_IDLE_SECS = '2';
      }
      if (values.profile === 'file-ttl') {
        env.DOWNLOAD_URL_SECS = '2';
        env.UPLOAD_SESSION_SECS = '5';
      }
      if (values.profile === 'retention') {
        env.LAB_OBSERVATION_RETENTION_SECS = '2';
        env.LAB_RECORD_RETENTION_SECS = '3';
      }
      if (values.profile === 'rate') env.RATE_LIMIT_WINDOW_SECS = '5';
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
          const worker = spawnOwned(
            resolve(targetDirectory, 'debug/labos-threejs-worker'),
            [],
            {
              ...env,
              WORKER_BIND: `127.0.0.1:${workerPort}`,
              JOB_MAINTENANCE_SECS: '1',
              JOB_SHUTDOWN_SECS: '1',
            },
            'file-cleanup-worker-process-group',
          );
          if (values['lifecycle-barrier'] === 'worker-wait') {
            resource.data.stage = 'worker-wait';
            resource.save();
            await waitFor(`http://127.0.0.1:${workerPort}/not-ready`, worker);
          } else
            await waitFor(
              `http://127.0.0.1:${workerPort}/health/ready`,
              worker,
            );
        }
        const api = spawnOwned(
          'node',
          ['scripts/lib/contract-target.mjs'],
          env,
          'target-process-group',
        );
        await waitFor(`${origin}/health/ready`, api);
        assertOpen();
        const bootstrapBody = JSON.stringify({
          email: env.CONTRACT_OWNER_EMAIL,
          password: env.CONTRACT_OWNER_PASSWORD,
        });
        const pendingBootstrap =
          values['lifecycle-barrier'] === 'register-wait';
        if (pendingBootstrap) {
          resource.data.stage = 'register-wait';
          resource.save();
        }
        const bootstrap = await fetch(`${origin}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: pendingBootstrap
            ? new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(bootstrapBody.slice(0, -1)),
                  );
                },
              })
            : bootstrapBody,
          ...(pendingBootstrap ? { duplex: 'half' } : {}),
          signal: AbortSignal.timeout(10_000),
        });
        if (
          bootstrap.status !== 201 ||
          (await bootstrap.json()).user.role !== 'owner'
        )
          throw new Error('Could not initialize isolated Owner through HTTP');
        assertOpen();
        resource.reconcile('before-tests');
        resource.data.stage = 'target-ready';
        resource.save();
        if (values['lifecycle-probe']) await new Promise(() => {});
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
        await Promise.all(children.map(stopOwned));
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
    clearInterval(observer);
    try {
      await close();
    } catch (error) {
      resource.data.state = 'cleanup-failed';
      throw error;
    } finally {
      resource.snapshot('end');
    }
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    console.log(`Contract evidence: ${directory}`);
  }
}
