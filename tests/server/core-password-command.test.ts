import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ServerProcess } from '../support/server-process.ts';
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
