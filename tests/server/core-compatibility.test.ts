import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AuditPage,
  ApiKeyPage,
  CreatedApiKey,
  MemberPage,
  Member,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';

test('sequential audit and key pages retain newest-first creation order and opaque continuation', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url),
      second = new CoreHttp(target.url),
      third = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    await second.register('second@example.test');
    await third.register('third@example.test');
    const page = await owner.json<AuditPage>(
      'GET',
      '/api/v1/audit-events?action=identity.register&limit=2',
    );
    assert.deepEqual(
      page.data.map((row) => row.actor_id),
      [third.session!.user.id, second.session!.user.id],
    );
    const last = await owner.json<AuditPage>(
      'GET',
      `/api/v1/audit-events?action=identity.register&limit=2&cursor=${encodeURIComponent(page.next_cursor!)}`,
    );
    assert.deepEqual(
      last.data.map((row) => row.actor_id),
      [owner.session!.user.id],
    );
    assert.equal(last.has_more, false);
    const keys: CreatedApiKey[] = [];
    for (const name of ['K1', 'K2', 'K3'])
      keys.push(
        await owner.json(
          'POST',
          '/api/v1/api-keys',
          { name, scopes: ['profile:read'], expires_in_days: 1 },
          201,
        ),
      );
    const keyPage = await owner.json<ApiKeyPage>(
      'GET',
      '/api/v1/api-keys?limit=2',
    );
    assert.deepEqual(
      keyPage.data.map((row) => row.name),
      ['K3', 'K2'],
    );
    const keyLast = await owner.json<ApiKeyPage>(
      'GET',
      `/api/v1/api-keys?limit=2&cursor=${encodeURIComponent(keyPage.next_cursor!)}`,
    );
    assert.deepEqual(
      keyLast.data.map((row) => row.name),
      ['K1'],
    );
    await target.stop();
    await target.start();
    assert.deepEqual(
      (
        await owner.json<ApiKeyPage>('GET', '/api/v1/api-keys?limit=2')
      ).data.map((row) => row.id),
      keyPage.data.map((row) => row.id),
    );
  } finally {
    await target.cleanup();
  }
});

test('necessary real DB/Core app fault maps authenticated metadata storage failure and healthy recovery to retained envelopes', async () => {
  const db = new Database();
  const policy = { ...configuration().auth, origin: 'http://127.0.0.1:3100' };
  try {
    await db.initialize();
    const app = coreApp(
      { db, clock: { now: () => new Date().toISOString() } },
      'test',
      policy,
      () => {},
      { ...defaultRateOptions, enabled: false },
    );
    const registered = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: policy.origin },
      body: JSON.stringify({
        email: 'fault@example.test',
        password: 'a-long-test-password',
      }),
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    await registered.arrayBuffer();
    await db.script(
      { id: 'fault-install', kind: 'startup' },
      `create function labos_threejs_core.reject_touch() returns trigger language plpgsql as $$ begin raise exception 'controlled session failure'; end $$; create trigger reject_touch before update on labos_threejs_core.sessions for each row execute function labos_threejs_core.reject_touch();`,
    );
    for (const path of [
      '/api/v1/api-keys/scopes',
      '/api/v1/system/rate-limits',
    ]) {
      const failed = await app.request(path, { headers: { cookie } });
      assert.equal(failed.status, 503);
      const envelope = await failed.json();
      assert.equal(envelope.error.code, 'auth.unavailable');
      assert.equal(
        envelope.error.request_id,
        failed.headers.get('x-request-id'),
      );
      assert.equal(JSON.stringify(envelope).includes(cookie), false);
    }
    await db.script(
      { id: 'fault-remove', kind: 'startup' },
      'drop trigger reject_touch on labos_threejs_core.sessions',
    );
    const recovered = await app.request('/api/v1/api-keys/scopes', {
      headers: { cookie },
    });
    assert.equal(recovered.status, 200);
    assert.equal(
      (await recovered.json()).data.some(
        (row: { id: string }) => row.id === 'profile:read',
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

test('simple URN and braced UUID forms identify the same retained filters and mutations', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url),
      member = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    await member.register('member@example.test');
    const id = member.session!.user.id;
    const canonical = await owner.json<AuditPage>(
      'GET',
      `/api/v1/audit-events?action=identity.register&actor_id=${id}`,
    );
    for (const alias of [
      id.replaceAll('-', ''),
      `urn:uuid:${id}`,
      `{${id.toUpperCase()}}`,
    ])
      assert.deepEqual(
        await owner.json<AuditPage>(
          'GET',
          `/api/v1/audit-events?action=identity.register&actor_id=${encodeURIComponent(alias)}`,
        ),
        canonical,
      );
    const row = (
      await owner.json<MemberPage>('GET', '/api/v1/organization/members')
    ).data.find((row) => row.user_id === id)!;
    const changed = await owner.json<Member>(
      'PUT',
      `/api/v1/organization/members/${id.replaceAll('-', '')}`,
      { role: 'admin', active: true, version: row.version },
    );
    assert.equal(changed.user_id, id);
    const filteredPage = await owner.json<AuditPage>(
      'GET',
      `/api/v1/audit-events?actor_id=${owner.session!.user.id}&limit=1`,
    );
    assert.equal(filteredPage.has_more, true);
    const filterContinuation = `&limit=1&cursor=${encodeURIComponent(filteredPage.next_cursor!)}`;
    const canonicalLast = await owner.json<AuditPage>(
      'GET',
      `/api/v1/audit-events?actor_id=${owner.session!.user.id}${filterContinuation}`,
    );
    assert.deepEqual(
      await owner.json<AuditPage>(
        'GET',
        `/api/v1/audit-events?actor_id=${owner.session!.user.id.replaceAll('-', '')}${filterContinuation}`,
      ),
      canonicalLast,
    );
    await owner.error(
      'GET',
      `/api/v1/audit-events?actor_id=${id}${filterContinuation}`,
      undefined,
      400,
      'audit.invalid_page',
    );
    const key = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Alias key', scopes: ['profile:read'], expires_in_days: 1 },
      201,
    );
    await member.json(
      'DELETE',
      `/api/v1/api-keys/${key.key.id.replaceAll('-', '')}`,
      undefined,
      204,
    );
    await member.error(
      'GET',
      '/api/v1/profile',
      undefined,
      401,
      'auth.unauthorized',
      { authorization: `Bearer ${key.secret}` },
    );
    const job = await owner.json<AuditPage>(
      'GET',
      `/api/v1/audit-events?job_id=${id.replaceAll('-', '')}`,
    );
    assert.deepEqual(job.data, []);
  } finally {
    await target.cleanup();
  }
});
