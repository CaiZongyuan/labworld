import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  MemberPage,
  Member,
  CurrentSession,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

test('Owner reads real members and Member refusal leaves membership state unchanged', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url);
    const member = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    await member.register('member@example.test');
    const before = await owner.json<MemberPage>(
      'GET',
      '/api/v1/organization/members',
    );
    assert.equal(before.data.length, 2);
    assert.deepEqual(before.assignable_roles, ['owner', 'admin', 'member']);
    assert.equal(
      before.data.find((row) => row.user_id === owner.session!.user.id)!
        .can_edit,
      true,
    );
    assert.equal(
      before.data.find((row) => row.user_id === member.session!.user.id)!.role,
      'member',
    );
    await member.error(
      'GET',
      '/api/v1/organization/members',
      undefined,
      403,
      'organization.forbidden',
    );
    assert.deepEqual(
      await owner.json<MemberPage>('GET', '/api/v1/organization/members'),
      before,
    );
  } finally {
    await target.cleanup();
  }
});

test('member changes preserve last Owner, CAS, Admin boundaries and deactivation recovery', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url);
    const member = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    await member.register('member@example.test');
    const read = () =>
      owner.json<MemberPage>('GET', '/api/v1/organization/members');
    const before = await read();
    const own = before.data.find(
      (row) => row.user_id === owner.session!.user.id,
    )!;
    const other = before.data.find(
      (row) => row.user_id === member.session!.user.id,
    )!;
    const path = (id: string) => `/api/v1/organization/members/${id}`;
    await member.error(
      'PUT',
      path(other.user_id),
      { role: 'admin', active: true, version: other.version },
      403,
      'organization.forbidden',
    );
    assert.deepEqual(await read(), before);
    await owner.error(
      'PUT',
      path(own.user_id),
      { role: 'member', active: true, version: own.version },
      422,
      'organization.last_owner',
    );
    assert.deepEqual(await read(), before);
    const changed = await owner.json<Member>('PUT', path(other.user_id), {
      role: 'admin',
      active: true,
      version: other.version,
    });
    assert.equal(changed.version, other.version + 1);
    await owner.error(
      'PUT',
      path(other.user_id),
      { role: 'member', active: true, version: other.version },
      409,
      'organization.version_conflict',
    );
    assert.deepEqual(
      (await read()).data.find((row) => row.user_id === other.user_id),
      changed,
    );
    await member.error(
      'PUT',
      path(own.user_id),
      { role: 'member', active: true, version: own.version },
      403,
      'organization.forbidden',
    );
    const adminPage = await member.json<MemberPage>(
      'GET',
      '/api/v1/organization/members',
    );
    assert.deepEqual(adminPage.assignable_roles, ['admin', 'member']);
    assert.equal(
      adminPage.data.find((row) => row.user_id === own.user_id)!.can_edit,
      false,
    );
    const disabled = await owner.json<Member>('PUT', path(other.user_id), {
      role: 'member',
      active: false,
      version: changed.version,
    });
    await member.error(
      'GET',
      '/api/v1/auth/session',
      undefined,
      401,
      'auth.unauthorized',
    );
    await owner.json('PUT', path(other.user_id), {
      role: 'member',
      active: true,
      version: disabled.version,
    });
    await member.error(
      'GET',
      '/api/v1/auth/session',
      undefined,
      401,
      'auth.unauthorized',
    );
    await member.login(member.session!.user.email);
    const recovered = await member.json<CurrentSession>(
      'GET',
      '/api/v1/auth/session',
    );
    assert.equal(recovered.user.id, other.user_id);
    assert.equal(recovered.user.role, 'member');
  } finally {
    await target.cleanup();
  }
});
