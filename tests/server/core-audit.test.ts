import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditPage } from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
test('audit records the original operator and rejects unauthorized or invalid reads without secrets', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url);
    const member = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    await member.register('member@example.test');
    await member.error(
      'GET',
      '/api/v1/audit-events',
      undefined,
      403,
      'audit.forbidden',
    );
    const path = `/api/v1/audit-events?action=identity.register&actor_id=${member.session!.user.id}&limit=1`;
    const page = await owner.json<AuditPage>('GET', path);
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0].actor_id, member.session!.user.id);
    assert.equal(page.data[0].actor_type, 'user');
    assert.equal(page.data[0].action, 'identity.register');
    assert.equal(page.data[0].resource_id, member.session!.user.id);
    assert.equal(typeof page.data[0].request_id, 'string');
    assert.equal(
      JSON.stringify(page).includes('contract-isolated-password'),
      false,
    );
    assert.equal(
      JSON.stringify(page).includes(member.session!.user.email),
      false,
    );
    await owner.error(
      'GET',
      '/api/v1/audit-events?limit=101',
      undefined,
      400,
      'audit.invalid_page',
    );
    assert.deepEqual(await owner.json<AuditPage>('GET', path), page);
  } finally {
    await target.cleanup();
  }
});
