import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';
test('necessary real audit failures roll membership session revocation key creation and key revocation back with healthy recovery', async () => {
  const db = new Database(),
    policy = configuration().auth;
  const context = { db, clock: { now: () => new Date().toISOString() } };
  try {
    await db.initialize();
    const app = coreApp(context, 'test', policy, () => {}, {
      ...defaultRateOptions,
      enabled: false,
    });
    const register = async (email: string) => {
      const response = await app.request('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: policy.origin },
        body: JSON.stringify({ email, password: 'isolated-audit-password' }),
      });
      assert.equal(response.status, 201);
      const session = await response.json();
      return {
        session,
        headers: {
          'content-type': 'application/json',
          origin: policy.origin,
          cookie: response.headers.get('set-cookie')!.split(';')[0],
          'x-csrf-token': session.csrf_token,
        },
      };
    };
    const owner = await register('owner@example.test'),
      member = await register('member@example.test');
    const request = async (
      headers: HeadersInit,
      method: string,
      path: string,
      body: unknown,
      status: number,
    ) => {
      const response = await app.request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, status);
      const value =
        status === 204
          ? (await response.arrayBuffer(), undefined)
          : await response.json();
      if (status === 503)
        assert.equal(
          value.error.request_id,
          response.headers.get('x-request-id'),
        );
      return value;
    };
    const list = () =>
      request(
        owner.headers,
        'GET',
        '/api/v1/organization/members',
        undefined,
        200,
      );
    const before = await list();
    const row = before.data.find(
      (row: { user_id: string }) => row.user_id === member.session.user.id,
    );
    await db.script(
      { id: 'permissions-audit-fault', kind: 'startup' },
      `create function labos_threejs_core.reject_permission_audit() returns trigger language plpgsql as $$ begin if NEW.action in ('organization.member.update','api_keys.create','api_keys.revoke') then raise exception 'controlled permission audit failure'; end if; return NEW; end $$; create trigger reject_permission_audit before insert on labos_threejs_core.audit_events for each row execute function labos_threejs_core.reject_permission_audit();`,
    );
    const changed = { role: 'admin', active: false, version: row.version };
    const failure = await request(
      owner.headers,
      'PUT',
      `/api/v1/organization/members/${row.user_id}`,
      changed,
      503,
    );
    assert.equal(failure.error.code, 'organization.unavailable');
    assert.deepEqual(await list(), before);
    await request(
      member.headers,
      'GET',
      '/api/v1/auth/session',
      undefined,
      200,
    );
    const input = {
      name: 'Audit key',
      scopes: ['profile:read'],
      expires_in_days: 1,
    };
    assert.equal(
      (await request(member.headers, 'POST', '/api/v1/api-keys', input, 503))
        .error.code,
      'api_keys.unavailable',
    );
    assert.deepEqual(
      (await request(member.headers, 'GET', '/api/v1/api-keys', undefined, 200))
        .data,
      [],
    );
    await db.script(
      { id: 'permissions-audit-recover', kind: 'startup' },
      'drop trigger reject_permission_audit on labos_threejs_core.audit_events',
    );
    const key = await request(
      member.headers,
      'POST',
      '/api/v1/api-keys',
      input,
      201,
    );
    await db.script(
      { id: 'revoke-audit-fault', kind: 'startup' },
      'create trigger reject_permission_audit before insert on labos_threejs_core.audit_events for each row execute function labos_threejs_core.reject_permission_audit()',
    );
    await request(
      member.headers,
      'DELETE',
      `/api/v1/api-keys/${key.key.id}`,
      undefined,
      503,
    );
    const profile = await request(
      { authorization: `Bearer ${key.secret}` },
      'GET',
      '/api/v1/profile',
      undefined,
      200,
    );
    assert.equal(profile.id, member.session.user.id);
    assert.equal(
      (await request(member.headers, 'GET', '/api/v1/api-keys', undefined, 200))
        .data[0].revoked_at,
      null,
    );
    await db.script(
      { id: 'permissions-final-recover', kind: 'startup' },
      'drop trigger reject_permission_audit on labos_threejs_core.audit_events',
    );
    await request(
      member.headers,
      'DELETE',
      `/api/v1/api-keys/${key.key.id}`,
      undefined,
      204,
    );
    await request(
      { authorization: `Bearer ${key.secret}` },
      'GET',
      '/api/v1/profile',
      undefined,
      401,
    );
    const recovered = await request(
      owner.headers,
      'PUT',
      `/api/v1/organization/members/${row.user_id}`,
      { ...changed, active: true },
      200,
    );
    assert.equal(recovered.version, row.version + 1);
  } finally {
    await db.close();
  }
});
