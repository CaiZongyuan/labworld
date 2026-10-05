import { beforeAll, expect, test } from 'vitest';
import type {
  CurrentSession,
  SystemStatus,
  LabPage,
} from '../../packages/contracts/src/generated/types.gen';
import { HttpClient, member, origin } from './http';

let owner: HttpClient;
beforeAll(async () => {
  owner = await member();
  expect(owner.session?.user.role).toBe('owner');
});
test('CORE-01 real health and status report connected database and actual versions', async () => {
  const client = new HttpClient();
  expect((await client.response('GET', '/health/live')).status).toBe(200);
  expect((await client.response('GET', '/health/ready')).status).toBe(200);
  const status = await client.json<SystemStatus>(
    'GET',
    '/api/v1/system/status',
  );
  expect(status).toMatchObject({
    status: 'ok',
    service: 'labos-threejs-api',
    database: 'connected',
  });
  expect(status.version).toEqual(expect.any(String));
  expect(status.version.length).toBeGreaterThan(0);
  expect(status.schema_version).toBeGreaterThan(0);
});
test('CORE-02 persistent member session rejects missing CSRF, preserves world, and recovers', async () => {
  const client = await member();
  expect(client.session?.user.role).toBe('member');
  const session = await client.json<CurrentSession>(
    'GET',
    '/api/v1/auth/session',
  );
  expect(session).toEqual(client.session);
  const before = await client.json<LabPage>('GET', '/api/v1/lab/labs');
  await client.error(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Denied Lab' },
    403,
    undefined,
    { 'x-csrf-token': '' },
  );
  expect(await client.json<LabPage>('GET', '/api/v1/lab/labs')).toEqual(before);
  await client.json(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Recovered Lab' },
    201,
    process.env.CONTRACT_ORACLE_PROBE === 'csrf' ? { 'x-csrf-token': '' } : {},
  );
  await client.error('POST', '/api/v1/auth/logout', {}, 403, undefined, {
    origin: 'https://untrusted.test',
  });
  expect(
    await client.json<CurrentSession>('GET', '/api/v1/auth/session'),
  ).toEqual(session);
  expect(
    (await client.response('POST', '/api/v1/auth/logout', {})).status,
  ).toBe(204);
  await client.error('GET', '/api/v1/auth/session', undefined, 401);
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
});
test('CORE-03 valid Agent writes full Lab, invalid Bearer never falls back to Cookie, revocation denies', async () => {
  const client = await member();
  const { client: agent, credential } = await client.agent();
  const lab = await agent.json<{ id: string }>(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Agent Lab' },
    201,
  );
  expect(
    (await client.json<LabPage>('GET', '/api/v1/lab/labs')).data.some(
      (entry) => entry.id === lab.id,
    ),
  ).toBe(true);
  const before = await client.json<LabPage>('GET', '/api/v1/lab/labs');
  await client.error(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Invalid Bearer Lab' },
    401,
    undefined,
    { authorization: 'Bearer invalid' },
  );
  expect(await client.json<LabPage>('GET', '/api/v1/lab/labs')).toEqual(before);
  await client.json(
    'DELETE',
    `/api/v1/api-keys/${credential.key.id}`,
    undefined,
    204,
  );
  await agent.error('GET', `/api/v1/lab/labs/${lab.id}/world`, undefined, 401);
  expect(
    (await client.json<LabPage>('GET', '/api/v1/lab/labs')).data.some(
      (entry) => entry.id === lab.id,
    ),
  ).toBe(true);
});
