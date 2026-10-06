import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';
import { resetPassword } from '../../packages/server/src/core/identity/password-reset.ts';
import { issueSession } from '../../packages/server/src/core/identity/use-cases.ts';
import { verifyPassword } from '../../packages/server/src/platform/crypto.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';
test('necessary real DB reset fault rolls password session revocation audit back; stale verified hash cannot issue a session after recovery', async () => {
  const db = new Database();
  const policy = configuration().auth;
  const context = { db, clock: { now: () => new Date().toISOString() } };
  const email = 'reset-fault@example.test',
    oldPassword = 'old-isolated-test-password',
    newPassword = 'new-isolated-test-password';
  try {
    await db.initialize();
    const app = coreApp(context, 'test', policy, () => {}, {
      ...defaultRateOptions,
      enabled: false,
    });
    const registered = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: policy.origin },
      body: JSON.stringify({ email, password: oldPassword }),
    });
    assert.equal(registered.status, 201);
    const session = await registered.json();
    const headers = {
      cookie: registered.headers.get('set-cookie')!.split(';')[0],
    };
    // Necessary race supplement: capture the actual verified credential used by issueSession.
    const [snapshot] = await db.readSQL<{ password_hash: string }>(
      { id: 'verified-credential-snapshot', kind: 'request' },
      'select password_hash from labos_threejs_core.credentials where user_id=$1::uuid',
      [session.user.id],
    );
    assert.equal(
      await verifyPassword(oldPassword, snapshot.password_hash),
      true,
    );
    await db.script(
      { id: 'reset-audit-fault', kind: 'startup' },
      `create function labos_threejs_core.reject_reset_audit() returns trigger language plpgsql as $$ begin if NEW.action='identity.password_reset' then raise exception 'controlled reset audit failure'; end if; return NEW; end $$; create trigger reject_reset_audit before insert on labos_threejs_core.audit_events for each row execute function labos_threejs_core.reject_reset_audit();`,
    );
    await assert.rejects(
      resetPassword(context, email, newPassword, 'failed-reset'),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'auth.unavailable',
    );
    const current = await app.request('/api/v1/auth/session', { headers });
    assert.equal(current.status, 200);
    await current.arrayBuffer();
    const login = async (password: string) => {
      const response = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: policy.origin },
        body: JSON.stringify({ email, password }),
      });
      await response.arrayBuffer();
      return response.status;
    };
    assert.equal(await login(oldPassword), 200);
    assert.equal(await login(newPassword), 401);
    const before = await app.request(
      '/api/v1/audit-events?action=identity.password_reset',
      { headers },
    );
    assert.deepEqual((await before.json()).data, []);
    await db.script(
      { id: 'reset-audit-recover', kind: 'startup' },
      'drop trigger reject_reset_audit on labos_threejs_core.audit_events',
    );
    assert.deepEqual(
      await resetPassword(context, email, newPassword, 'healthy-reset'),
      { user_id: session.user.id },
    );
    await assert.rejects(
      issueSession(
        context,
        policy,
        session.user,
        snapshot.password_hash,
        'stale-verified-password',
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.status === 401,
    );
    const stale = await app.request('/api/v1/auth/session', { headers });
    assert.equal(stale.status, 401);
    await stale.arrayBuffer();
    assert.equal(await login(oldPassword), 401);
    assert.equal(await login(newPassword), 200);
  } finally {
    await db.close();
  }
});
