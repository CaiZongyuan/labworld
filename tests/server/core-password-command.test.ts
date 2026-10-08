import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerProcess, until } from '../support/server-process.ts';
import { processIdentity } from '../support/server-resources.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { CoreHttp } from '../support/core-http.ts';
import type { AuditPage } from '../../packages/contracts/src/generated/types.gen.ts';
test('real reset-password command revokes old sessions changes login records actual system actor and omits the password from output', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  const replacement = 'replacement-isolated-password';
  try {
    await target.start();
    const owner = new CoreHttp(target.url);
    await owner.register('command@example.test');
    const id = owner.session!.user.id;
    await target.stop();
    target.entry = 'apps/server/src/reset-password.ts';
    target.args = ['--email', 'command@example.test'];
    target.input = replacement + '\n';
    await target.spawn();
    if (target.child!.exitCode === null) await once(target.child!, 'exit');
    assert.equal(target.child!.exitCode, 0, target.logs);
    assert.equal(target.logs.includes(replacement), false);
    assert.deepEqual(JSON.parse(target.logs), { status: 'reset', user_id: id });
    await target.stop();
    target.entry = 'apps/server/src/main.ts';
    target.args = [];
    await target.start();
    await owner.error(
      'GET',
      '/api/v1/auth/session',
      undefined,
      401,
      'auth.unauthorized',
    );
    await owner.error(
      'POST',
      '/api/v1/auth/login',
      { email: 'command@example.test', password: 'contract-isolated-password' },
      401,
      'auth.invalid_credentials',
    );
    await owner.login('command@example.test', replacement);
    const audit = await owner.json<AuditPage>(
      'GET',
      '/api/v1/audit-events?action=identity.password_reset',
    );
    assert.equal(audit.data.length, 1);
    assert.equal(audit.data[0].actor_id, null);
    assert.equal(audit.data[0].actor_type, 'system');
    assert.equal(audit.data[0].resource_id, id);
    assert.equal(audit.data[0].metadata.subject_user_id, id);
    for (const [email, password, code] of [
      ['absent@example.test', replacement, 'auth.user_not_found'],
      ['not-an-email', replacement, 'auth.invalid_input'],
      ['command@example.test', 'short', 'auth.invalid_input'],
    ]) {
      await target.stop();
      target.entry = 'apps/server/src/reset-password.ts';
      target.args = ['--email', email];
      target.input = password + '\n';
      await target.spawn();
      if (target.child!.exitCode === null) await once(target.child!, 'exit');
      assert.equal(target.child!.exitCode, 1);
      assert.equal(JSON.parse(target.logs).error.code, code);
      assert.equal(target.logs.includes(password), false);
      await target.stop();
      target.entry = 'apps/server/src/main.ts';
      target.args = [];
      await target.start();
      await owner.json('GET', '/api/v1/auth/session');
      assert.equal(
        (
          await owner.json<AuditPage>(
            'GET',
            '/api/v1/audit-events?action=identity.password_reset',
          )
        ).data.length,
        1,
      );
    }
  } finally {
    await target.cleanup();
  }
});
test('necessary actual DB close plus controlled adapter filesystem rejection exits the password command and releases its owned directory', async () => {
  const target = await new ServerProcess().create();
  const password = 'isolated-close-fault-password';
  const driverFacts = join(
    target.evidence,
    'password-close-driver-phases.json',
  );
  target.env.OWNED_PASSWORD_CLOSE_FACTS = driverFacts;
  let failed = false;
  let originalFailure: unknown;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  let stage = 'spawn';
  try {
    target.entry = 'tests/support/password-storage-close-fault.ts';
    target.args = ['--email', 'fault@example.test'];
    target.input = password + '\n';
    await target.spawn();
    stage = 'wait-for-command-exit';
    await until(
      async () => target.child!.exitCode,
      (code) => code !== null,
      6500,
    );
    stage = 'check-command-result';
    assert.equal(target.child!.exitCode, 1);
    assert.equal(target.logs.includes(password), false);
    assert.equal(target.logs.includes('auth.unavailable'), true);
    stage = 'check-directory-release';
    const lease = await DirectoryLease.acquire(target.directory);
    await lease.release();
    stage = 'complete';
  } catch (error) {
    failed = true;
    originalFailure = error;
    const capturedAt = new Date().toISOString();
    const child = {
      pid: target.child?.pid ?? null,
      exitCode: target.child?.exitCode ?? null,
      signalCode: target.child?.signalCode ?? null,
    };
    // Freeze owning facts before the supervisor changes process and lease state.
    const phases = await readFile(driverFacts, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const identity = await Promise.race([
        child.pid
          ? processIdentity(child.pid).then(
              (value) => ({
                status: 'ack',
                present: !!value,
                identity: value ?? null,
              }),
              () => ({ status: 'error' }),
            )
          : Promise.resolve({ status: 'unknown' }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: 'timeout' }), 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      const lease = await Promise.race([
        DirectoryLease.reserve(target.directory).then(
          async (reservation) => {
            await reservation.release();
            return { status: 'ack', available: true };
          },
          (failure: NodeJS.ErrnoException) => ({
            status: 'error',
            code: failure.code ?? null,
          }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: 'timeout' }), 1000);
        }),
      ]);
      await writeFile(
        join(target.evidence, 'password-close-first-failure.json'),
        JSON.stringify(
          {
            capturedAt,
            stage,
            failure: {
              name: error instanceof Error ? error.name : 'OtherError',
              code: (error as NodeJS.ErrnoException)?.code ?? null,
            },
            child,
            identity,
            lease,
            phases,
            unavailableReported: target.logs.includes('auth.unavailable'),
            driverFacts: 'password-close-driver-phases.json',
            childLog: 'server.log',
            primaryLedger: 'owned-resources.json',
          },
          null,
          2,
        ),
      );
    } catch {
      /* Supplemental capture preserves the original failure. */
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    try {
      await target.cleanup();
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
      await writeFile(
        join(target.evidence, 'password-close-cleanup-failure.json'),
        JSON.stringify({
          name: error instanceof Error ? error.name : 'OtherError',
          code: (error as NodeJS.ErrnoException)?.code ?? null,
        }),
      ).catch(() => {});
    }
  }
  if (failed) throw originalFailure;
  if (cleanupFailed) throw cleanupFailure;
});
