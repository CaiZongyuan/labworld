import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import type {
  MemberPage,
  Member,
  AuditPage,
  ApiKeyPage,
  CreatedApiKey,
} from '../../packages/contracts/src/generated/types.gen.ts';
test('real member key audit pages are complete and actor/filter cursors cannot cross into another authorized account', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url),
      admin = new CoreHttp(target.url),
      member = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    await admin.register('admin@example.test');
    await member.register('member@example.test');
    const all = await owner.json<MemberPage>(
      'GET',
      '/api/v1/organization/members',
    );
    const adminRow = all.data.find(
      (row) => row.user_id === admin.session!.user.id,
    )!;
    await owner.json<Member>(
      'PUT',
      `/api/v1/organization/members/${adminRow.user_id}`,
      { role: 'admin', active: true, version: adminRow.version },
    );
    const first = await owner.json<MemberPage>(
      'GET',
      '/api/v1/organization/members?limit=1',
    );
    await admin.error(
      'GET',
      `/api/v1/organization/members?limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`,
      undefined,
      400,
      'organization.invalid_page',
    );
    const ids = first.data.map((row) => row.user_id);
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await owner.json<MemberPage>(
        'GET',
        `/api/v1/organization/members?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      ids.push(...page.data.map((row) => row.user_id));
      cursor = page.next_cursor;
    }
    assert.deepEqual(
      ids.slice().sort(),
      all.data.map((row) => row.user_id).sort(),
    );
    assert.equal(new Set(ids).size, 3);
    const audit = await owner.json<AuditPage>(
      'GET',
      '/api/v1/audit-events?action=identity.register&limit=1',
    );
    await admin.error(
      'GET',
      `/api/v1/audit-events?action=identity.register&limit=1&cursor=${encodeURIComponent(audit.next_cursor!)}`,
      undefined,
      400,
      'audit.invalid_page',
    );
    await owner.error(
      'GET',
      `/api/v1/audit-events?action=api_keys.create&limit=1&cursor=${encodeURIComponent(audit.next_cursor!)}`,
      undefined,
      400,
      'audit.invalid_page',
    );
    const create = (client: CoreHttp, name: string) =>
      client.json<CreatedApiKey>(
        'POST',
        '/api/v1/api-keys',
        { name, scopes: ['profile:read'], expires_in_days: 1 },
        201,
      );
    const a = await create(owner, 'owner-a'),
      b = await create(owner, 'owner-b'),
      foreign = await create(admin, 'admin');
    const keys = await owner.json<ApiKeyPage>(
      'GET',
      '/api/v1/api-keys?limit=1',
    );
    await admin.error(
      'GET',
      `/api/v1/api-keys?limit=1&cursor=${encodeURIComponent(keys.next_cursor!)}`,
      undefined,
      400,
      'api_keys.invalid_page',
    );
    await admin.error(
      'DELETE',
      `/api/v1/api-keys/${a.key.id}`,
      undefined,
      404,
      'api_keys.not_found',
    );
    assert.equal(
      (
        await owner.json<{ id: string }>(
          'GET',
          '/api/v1/profile',
          undefined,
          200,
          { authorization: `Bearer ${a.secret}` },
        )
      ).id,
      owner.session!.user.id,
    );
    const rest = await owner.json<ApiKeyPage>(
      'GET',
      `/api/v1/api-keys?limit=1&cursor=${encodeURIComponent(keys.next_cursor!)}`,
    );
    assert.deepEqual(
      [...keys.data, ...rest.data].map((row) => row.id).sort(),
      [a.key.id, b.key.id].sort(),
    );
    assert.deepEqual(
      (await admin.json<ApiKeyPage>('GET', '/api/v1/api-keys')).data.map(
        (row) => row.id,
      ),
      [foreign.key.id],
    );
  } finally {
    await target.cleanup();
  }
});
test('real concurrent membership CAS and last-Owner changes commit exactly one winner and retain an active Owner', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url),
      second = new CoreHttp(target.url),
      member = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    await second.register('second@example.test');
    await member.register('member@example.test');
    const read = () =>
      owner.json<MemberPage>('GET', '/api/v1/organization/members');
    let rows = (await read()).data;
    await owner.json(
      'PUT',
      `/api/v1/organization/members/${second.session!.user.id}`,
      {
        role: 'owner',
        active: true,
        version: rows.find((row) => row.user_id === second.session!.user.id)!
          .version,
      },
    );
    rows = (await read()).data;
    const targetRow = rows.find(
      (row) => row.user_id === member.session!.user.id,
    )!;
    const cas = await Promise.all([
      owner.response(
        'PUT',
        `/api/v1/organization/members/${targetRow.user_id}`,
        { role: 'admin', active: true, version: targetRow.version },
      ),
      second.response(
        'PUT',
        `/api/v1/organization/members/${targetRow.user_id}`,
        { role: 'member', active: true, version: targetRow.version },
      ),
    ]);
    assert.deepEqual(cas.map((response) => response.status).sort(), [200, 409]);
    const winner = await cas
      .find((response) => response.status === 200)!
      .json();
    await cas.find((response) => response.status === 409)!.arrayBuffer();
    const changed = (await read()).data.find(
      (row) => row.user_id === targetRow.user_id,
    )!;
    assert.equal(changed.role, winner.role);
    assert.equal(changed.version, targetRow.version + 1);
    rows = (await read()).data;
    const own = rows.find((row) => row.user_id === owner.session!.user.id)!,
      other = rows.find((row) => row.user_id === second.session!.user.id)!;
    const demotions = await Promise.all([
      owner.response('PUT', `/api/v1/organization/members/${own.user_id}`, {
        role: 'member',
        active: true,
        version: own.version,
      }),
      second.response('PUT', `/api/v1/organization/members/${other.user_id}`, {
        role: 'member',
        active: true,
        version: other.version,
      }),
    ]);
    assert.deepEqual(
      demotions.map((response) => response.status).sort(),
      [200, 422],
    );
    await Promise.all(demotions.map((response) => response.arrayBuffer()));
    const survivor = demotions[0].status === 422 ? owner : second;
    assert.equal(
      (
        await survivor.json<MemberPage>('GET', '/api/v1/organization/members')
      ).data.filter((row) => row.role === 'owner' && row.active).length,
      1,
    );
  } finally {
    await target.cleanup();
  }
});
