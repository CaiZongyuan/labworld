import { randomUUID } from 'node:crypto';
import { schemaVersion } from '../packages/server/src/platform/db/index.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { freePort, launch, root, waitFor } from './lib/process.mjs';
import { ContractResources } from './lib/contract-resources.mjs';

const { values, positionals } = parseArgs({
  options: {
    target: { type: 'string', default: 'candidate' },
    descriptor: { type: 'string' },
    recover: { type: 'string' },
    'no-build': { type: 'boolean' },
    timeout: { type: 'string', default: '900' },
    profile: { type: 'string', default: 'baseline' },
    'lifecycle-probe': { type: 'boolean' },
    'lifecycle-barrier': { type: 'string' },
    'run-id': { type: 'string' },
  },
  allowPositionals: true,
});
if (values.recover) {
  const resource = new ContractResources(resolve(values.recover));
  await resource.recover();
} else {
  if (values.target !== 'candidate')
    throw new Error('Contract target must be candidate');
  if (process.platform !== 'linux')
    throw new Error(
      'Owned full-contract process groups run on Linux; Windows Node checks use the server suite',
    );
  const runId = values['run-id'] ?? `${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9-]+$/.test(runId))
    throw new Error('Use a simple unique run id');
  const directory = resolve(root, '.scratch/vnext-m0/runs', runId);
  if (existsSync(directory))
    throw new Error(
      'Run directory already exists; use a new id or recover the original ledger',
    );
  mkdirSync(resolve(root, '.scratch/vnext-m0/runs'), { recursive: true });
  mkdirSync(directory);
  mkdirSync(resolve(directory, 'data'));
  const proofJournal = resolve(directory, 'target-process-proof.jsonl');
  writeFileSync(proofJournal, '', { mode: 0o600 });
  const resource = new ContractResources(
    resolve(directory, 'owned-resources.json'),
    runId,
    false,
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
    const intent = resource.planConsumer(
      role,
      role === 'target-process-group' ? proofJournal : undefined,
    );
    intent.bind =
      role === 'target-process-group'
        ? env.APP_BIND
        : role === 'file-cleanup-worker-process-group'
          ? env.WORKER_BIND
          : undefined;
    resource.save();
    const child = launch(command, args, {
      ...env,
      CONTRACT_RUN_ID: runId,
      CONTRACT_CONSUMER_MARKER: intent.marker,
    });
    if (!child.pid) {
      child.once('error', () => {});
      intent.state = 'not-started';
      resource.save();
      throw new Error(`Could not start ${role}`);
    }
    children.push(child);
    resource.launchedConsumer(intent.id, child.pid);
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
    children.splice(children.indexOf(child), 1);
    if (exit !== 0) throw new Error(`${role} exited ${exit}`);
  }
  let closing;
  async function close() {
    closing ??= (async () => {
      resource.data.closing = true;
      resource.save();
      const stopped = await Promise.allSettled(
        resource.data.consumers
          .filter((consumer) => consumer.pid)
          .map((consumer) => resource.stop(consumer.pid)),
      );
      resource.reconcile('before-cleanup');
      const failures = stopped.filter((result) => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Some consumer identities could not be stopped safely; resources retained',
        );
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
  const timeout = setTimeout(interrupted, Number(values.timeout) * 1000);
  let failure;
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
    async function exercise() {
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const descriptor = values.descriptor
        ? JSON.parse(readFileSync(resolve(values.descriptor), 'utf8'))
        : {
            command: process.execPath,
            args: ['apps/server/dist/apps/server/src/main.js'],
            version: JSON.parse(
              readFileSync(resolve(root, 'apps/server/package.json'), 'utf8'),
            ).version,
            schemaVersion,
          };
      const descriptorPath = resolve(directory, 'target.json');
      writeFileSync(descriptorPath, JSON.stringify(descriptor), {
        mode: 0o600,
      });
      const env = {
        ...process.env,
        APP_BIND: `127.0.0.1:${port}`,
        APP_ORIGIN: origin,
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
      };
      if (descriptor.version !== undefined)
        env.CONTRACT_EXPECTED_VERSION = String(descriptor.version);
      if (descriptor.schemaVersion !== undefined)
        env.CONTRACT_EXPECTED_SCHEMA = String(descriptor.schemaVersion);
      if (values.profile === 'capacity') env.RATE_LIMIT_ENABLED = 'false';
      if (values.profile === 'session-ttl') {
        env.SESSION_ABSOLUTE_SECS = '65';
        env.SESSION_IDLE_SECS = '60';
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
        if (values['lifecycle-barrier'] === 'consumer-orphan') {
          spawnOwned(
            'node',
            ['scripts/lib/contract-orphan-probe.mjs'],
            {
              ...env,
              CONTRACT_LIFECYCLE_CHILD_READY: resolve(
                directory,
                'orphan-child.pid',
              ),
            },
            'non-api-probe-group',
          );
        }
        if (values['lifecycle-probe']) await new Promise(() => {});
        await controlled(
          'pnpm',
          [
            'exec',
            'vitest',
            'run',
            '--config',
            'vitest.contract.config.ts',
            ...(values.profile === 'baseline' && positionals.length === 0
              ? ['core.test.ts', 'api.test.ts']
              : positionals),
          ],
          env,
          'vitest-process-group',
        );
      } finally {
        await Promise.all(children.map(stopOwned));
      }
    }
    await exercise();
    resource.data.state = 'completed';
  } catch (error) {
    resource.data.state = 'failed';
    failure = error;
  } finally {
    clearTimeout(timeout);
    try {
      await close();
    } catch (error) {
      resource.data.state = 'cleanup-failed';
      failure = failure
        ? new AggregateError(
            [failure, error],
            'Contract run and cleanup failed',
          )
        : error;
    } finally {
      resource.snapshot('end');
    }
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    console.log(`Contract evidence: ${directory}`);
  }
  if (failure) throw failure;
}
