import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '../../packages/contracts/src/generated/types.gen.ts';
import type {
  CreatedApiKey,
  ApiKeyPage,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

test('a Member creates a scoped key; listing exposes metadata once and CSRF refusal preserves it', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const member = new CoreHttp(target.url);
    await member.register('member@example.test');
    const key = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Core Agent',
        scopes: ['profile:read', 'lab:full'],
        expires_in_days: 1,
      },
      201,
    );
    assert.match(key.secret, /^labos_threejs_key_[0-9a-f]{64}$/);
    assert.equal(key.key.user_id, member.session!.user.id);
    const before = await member.json<ApiKeyPage>('GET', '/api/v1/api-keys');
    assert.equal(before.data.length, 1);
    assert.equal(before.data[0].id, key.key.id);
    assert.equal(JSON.stringify(before).includes(key.secret), false);
    await member.error(
      'POST',
      '/api/v1/api-keys',
      { name: 'Denied', scopes: ['profile:read'], expires_in_days: 1 },
      403,
      'auth.csrf',
      { 'x-csrf-token': '' },
    );
    await member.error(
      'POST',
      '/api/v1/api-keys',
      { name: 'Invalid', scopes: ['unknown'], expires_in_days: 1 },
      400,
      'api_keys.invalid_input',
    );
    assert.deepEqual(
      await member.json<ApiKeyPage>('GET', '/api/v1/api-keys'),
      before,
    );
    const scopes = await member.json<{ data: Array<{ id: string }> }>(
      'GET',
      '/api/v1/api-keys/scopes',
    );
    assert.equal(
      scopes.data.some((scope) => scope.id === 'profile:read'),
      true,
    );
    assert.equal(
      scopes.data.some((scope) => scope.id === 'lab:full'),
      true,
    );
  } finally {
    await target.cleanup();
  }
});

test('scoped Agent profile, explicit invalid Bearer and revocation preserve the identity boundary', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('member@example.test');
    const key = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Agent',
        scopes: ['profile:read', 'lab:full'],
        expires_in_days: 1,
      },
      201,
    );
    const agent = new CoreHttp(target.url);
    const authorization = { authorization: `Bearer ${key.secret}` };
    const profile = await agent.json<CurrentUser>(
      'GET',
      '/api/v1/profile',
      undefined,
      200,
      authorization,
    );
    assert.equal(profile.id, member.session!.user.id);
    await agent.error(
      'GET',
      '/api/v1/organization/members',
      undefined,
      401,
      'auth.unauthorized',
      authorization,
    );
    const before = await member.json<ApiKeyPage>('GET', '/api/v1/api-keys');
    await member.error(
      'GET',
      '/api/v1/profile',
      undefined,
      401,
      'auth.unauthorized',
      { authorization: 'Bearer invalid' },
    );
    assert.deepEqual(
      await member.json<ApiKeyPage>('GET', '/api/v1/api-keys'),
      before,
    );
    await member.json(
      'DELETE',
      `/api/v1/api-keys/${key.key.id}`,
      undefined,
      204,
    );
    await member.json(
      'DELETE',
      `/api/v1/api-keys/${key.key.id}`,
      undefined,
      204,
    );
    await agent.error(
      'GET',
      '/api/v1/profile',
      undefined,
      401,
      'auth.unauthorized',
      authorization,
    );
    const replacement = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Replacement', scopes: ['profile:read'], expires_in_days: 1 },
      201,
    );
    assert.equal(
      (
        await agent.json<CurrentUser>(
          'GET',
          '/api/v1/profile',
          undefined,
          200,
          { authorization: `Bearer ${replacement.secret}` },
        )
      ).id,
      profile.id,
    );
  } finally {
    await target.cleanup();
  }
});
