import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';
import {
  requireAccess,
  revalidateIn,
} from '../../packages/server/src/core/api-keys/authentication.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';

test('necessary publication capability rechecks the exact browser credential after logout and exposes no internal identity in HTTP DTOs', async () => {
  const db = new Database();
  const policy = configuration().auth;
  const context = { db, clock: { now: () => new Date().toISOString() } };
  try {
    await db.initialize();
    const app = coreApp(context, 'test', policy, () => {}, {
      ...defaultRateOptions,
      enabled: false,
    });
    const registered = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: policy.origin },
      body: JSON.stringify({
        email: 'publication@example.test',
        password: 'a-long-test-password',
      }),
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    const session = await registered.json();
    assert.deepEqual(Object.keys(session).sort(), ['csrf_token', 'user']);
    assert.deepEqual(Object.keys(session.user).sort(), [
      'display_name',
      'email',
      'id',
      'role',
    ]);
    const headers = new Headers({
      cookie,
      origin: policy.origin,
      'x-csrf-token': session.csrf_token,
    });
    const actor = await requireAccess(
      context,
      policy,
      headers,
      'begin',
      'lab:full',
      true,
    );
    assert.equal(actor.isApiKey, false);
    assert.equal(typeof actor.credentialId, 'string');
    await db.script(
      { id: 'refuse-touch', kind: 'startup' },
      `create function labos_threejs_core.refuse_touch() returns trigger language plpgsql as $$ begin raise exception 'non-touch check attempted a write'; end $$; create trigger refuse_touch before update on labos_threejs_core.sessions for each row execute function labos_threejs_core.refuse_touch();`,
    );
    assert.equal(
      (
        await db.transaction({ id: 'non-touch', kind: 'request' }, (tx) =>
          revalidateIn(tx, context, policy, actor, 'lab:full'),
        )
      ).credentialId,
      actor.credentialId,
    );
    await db.script(
      { id: 'allow-touch', kind: 'startup' },
      'drop trigger refuse_touch on labos_threejs_core.sessions',
    );
    const signedOut = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers,
    });
    assert.equal(signedOut.status, 204);
    await signedOut.arrayBuffer();
    await assert.rejects(
      db.transaction({ id: 'final-publication', kind: 'request' }, (tx) =>
        revalidateIn(tx, context, policy, actor, 'lab:full'),
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.status === 401,
    );
  } finally {
    await db.close();
  }
});

test('necessary Lab full capability gives Member and scoped Agent equal access, refuses missing scope without touching it, and rechecks expiry/revocation', async () => {
  const db = new Database();
  const policy = configuration().auth;
  let now = Date.now();
  const context = { db, clock: { now: () => new Date(now).toISOString() } };
  try {
    await db.initialize();
    const app = coreApp(context, 'test', policy, () => {}, {
      ...defaultRateOptions,
      enabled: false,
    });
    const signUp = async (email: string) => {
      const response = await app.request('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: policy.origin },
        body: JSON.stringify({ email, password: 'a-long-test-password' }),
      });
      assert.equal(response.status, 201);
      const session = await response.json();
      return {
        session,
        headers: new Headers({
          'content-type': 'application/json',
          cookie: response.headers.get('set-cookie')!.split(';')[0],
          origin: policy.origin,
          'x-csrf-token': session.csrf_token,
        }),
      };
    };
    await signUp('owner@example.test');
    const member = await signUp('member@example.test');
    assert.equal(member.session.user.role, 'member');
    assert.equal(
      (
        await requireAccess(
          context,
          policy,
          member.headers,
          'member-access',
          'lab:full',
          true,
        )
      ).user.id,
      member.session.user.id,
    );
    const newKey = async (
      scopes: string[],
      name: string,
      expires_in_days = 1,
    ) => {
      const response = await app.request('/api/v1/api-keys', {
        method: 'POST',
        headers: member.headers,
        body: JSON.stringify({ name, scopes, expires_in_days }),
      });
      return { status: response.status, value: await response.json() };
    };
    const invalid = await newKey(['lab:full'], 'Invalid', 0);
    assert.equal(invalid.status, 400);
    const scoped = await newKey(['lab:full'], 'Lab full');
    assert.equal(scoped.status, 201);
    assert.equal(Date.parse(scoped.value.key.expires_at) - now, 86400000);
    const headers = new Headers({
      authorization: `Bearer ${scoped.value.secret}`,
    });
    const actor = await requireAccess(
      context,
      policy,
      headers,
      'agent-access',
      'lab:full',
      true,
    );
    assert.equal(actor.user.id, member.session.user.id);
    assert.equal(actor.credentialId, scoped.value.key.id);
    const before = await app.request('/api/v1/api-keys', {
      headers: member.headers,
    });
    const initial = (await before.json()).data.find(
      (key: { id: string }) => key.id === actor.credentialId,
    );
    assert.equal(initial.last_used_at !== null, true);
    await assert.rejects(
      requireAccess(context, policy, headers, 'missing-scope', 'profile:read'),
      (error: unknown) =>
        error instanceof PublicFailure && error.status === 403,
    );
    await db.script(
      { id: 'refuse-key-touch', kind: 'startup' },
      `create function labos_threejs_core.refuse_key_touch() returns trigger language plpgsql as $$ begin raise exception 'non-touch key check attempted a write'; end $$; create trigger refuse_key_touch before update on labos_threejs_core.api_keys for each row execute function labos_threejs_core.refuse_key_touch();`,
    );
    assert.equal(
      (
        await db.transaction({ id: 'non-touch-key', kind: 'request' }, (tx) =>
          revalidateIn(tx, context, policy, actor, 'lab:full'),
        )
      ).credentialId,
      actor.credentialId,
    );
    await db.script(
      { id: 'allow-key-touch', kind: 'startup' },
      'drop trigger refuse_key_touch on labos_threejs_core.api_keys',
    );
    const after = await app.request('/api/v1/api-keys', {
      headers: member.headers,
    });
    assert.equal(
      (await after.json()).data.find(
        (key: { id: string }) => key.id === actor.credentialId,
      ).last_used_at,
      initial.last_used_at,
    );
    now += 86400000;
    await assert.rejects(
      db.transaction({ id: 'expired-key', kind: 'request' }, (tx) =>
        revalidateIn(tx, context, policy, actor, 'lab:full'),
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.status === 401,
    );
    now -= 86400000;
    const revoked = await app.request(
      `/api/v1/api-keys/${actor.credentialId}`,
      { method: 'DELETE', headers: member.headers },
    );
    assert.equal(revoked.status, 204);
    await revoked.arrayBuffer();
    await assert.rejects(
      db.transaction({ id: 'revoked-key', kind: 'request' }, (tx) =>
        revalidateIn(tx, context, policy, actor, 'lab:full'),
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.status === 401,
    );
  } finally {
    await db.close();
  }
});
