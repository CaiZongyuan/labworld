import { beforeAll, expect, test } from 'vitest';
import type {
  CurrentSession,
  SystemStatus,
  LabPage,
} from '../../packages/contracts/src/generated/types.gen';
import { HttpClient, member, origin } from './http';

let owner: HttpClient;
beforeAll(async () => {
  owner = new HttpClient();
  await owner.login(process.env.CONTRACT_OWNER_EMAIL!);
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
  expect(Number.isInteger(status.schema_version)).toBe(true);
  expect(status.schema_version).toBeGreaterThanOrEqual(0);
  if (process.env.CONTRACT_EXPECTED_VERSION)
    expect(status.version).toBe(process.env.CONTRACT_EXPECTED_VERSION);
  if (process.env.CONTRACT_EXPECTED_SCHEMA)
    expect(status.schema_version).toBe(
      Number(process.env.CONTRACT_EXPECTED_SCHEMA),
    );
});
test('CORE-02 persistent member session rejects missing CSRF, preserves world, and recovers', async () => {
  const client = await member();
  expect(client.session?.user.role).toBe('member');
  const session = await client.json<CurrentSession>(
    'GET',
    '/api/v1/auth/session',
  );
  expect(session.user).toEqual(client.session!.user);
  expect(session.csrf_token === client.csrf).toBe(true);
  const before = await client.json<LabPage>('GET', '/api/v1/lab/labs');
  await client.error(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Denied Lab' },
    403,
    'auth.csrf',
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
  await client.error('POST', '/api/v1/auth/logout', {}, 403, 'auth.origin', {
    origin: 'https://untrusted.test',
  });
  const retainedSession = await client.json<CurrentSession>(
    'GET',
    '/api/v1/auth/session',
  );
  expect(retainedSession.user).toEqual(session.user);
  expect(retainedSession.csrf_token === session.csrf_token).toBe(true);
  expect(
    (await client.response('POST', '/api/v1/auth/logout', {})).status,
  ).toBe(204);
  await client.error(
    'GET',
    '/api/v1/auth/session',
    undefined,
    401,
    'auth.unauthorized',
  );
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
    'auth.unauthorized',
    { authorization: 'Bearer invalid' },
  );
  expect(await client.json<LabPage>('GET', '/api/v1/lab/labs')).toEqual(before);
  await client.json(
    'DELETE',
    `/api/v1/api-keys/${credential.key.id}`,
    undefined,
    204,
  );
  await agent.error(
    'GET',
    `/api/v1/lab/labs/${lab.id}/world`,
    undefined,
    401,
    'auth.unauthorized',
  );
  expect(
    (await client.json<LabPage>('GET', '/api/v1/lab/labs')).data.some(
      (entry) => entry.id === lab.id,
    ),
  ).toBe(true);
});

test('CORE-04 registration validation and normalized duplicate rejection preserve password; login rotates session', async () => {
  const anonymous = new HttpClient();
  await anonymous.error(
    'POST',
    '/api/v1/auth/register',
    { email: 'invalid', password: 'short' },
    400,
    'auth.invalid_input',
  );
  const email = `normalized-${crypto.randomUUID()}@example.test`;
  await anonymous.error(
    'POST',
    '/api/v1/auth/register',
    { email, password: 'contract-isolated-password' },
    403,
    'auth.origin',
    { origin: 'null' },
  );
  const client = new HttpClient();
  await client.register(email);
  const originalCookie = client.cookie;
  await anonymous.error(
    'POST',
    '/api/v1/auth/register',
    { email: ` ${email.toUpperCase()} `, password: 'different-long-password' },
    409,
    'auth.email_exists',
  );
  await anonymous.error(
    'POST',
    '/api/v1/auth/login',
    { email, password: 'different-long-password' },
    401,
    'auth.invalid_credentials',
  );
  const login = new HttpClient();
  await login.login(` ${email.toUpperCase()} `);
  expect(login.session?.user.id).toBe(client.session?.user.id);
  expect(login.cookie !== originalCookie).toBe(true);
  const session = await login.response('GET', '/api/v1/auth/session');
  expect(session.headers.get('cache-control')).toBe('no-store');
  const current = (await session.json()) as CurrentSession;
  expect(current.user).toEqual(login.session!.user);
  expect(current.csrf_token === login.csrf).toBe(true);
});

test('CORE-05 scoped Agent cannot gain member administration; new valid key recovers after revocation', async () => {
  const client = await member();
  const { client: limited, credential } = await client.agent(['profile:read']);
  const profile = await limited.json<{ id: string }>('GET', '/api/v1/profile');
  expect(profile.id).toBe(client.session?.user.id);
  await limited.error(
    'GET',
    '/api/v1/lab/labs',
    undefined,
    403,
    'api_keys.scope_forbidden',
  );
  await limited.error(
    'GET',
    '/api/v1/organization/members',
    undefined,
    401,
    'auth.unauthorized',
  );
  await client.json(
    'DELETE',
    `/api/v1/api-keys/${credential.key.id}`,
    undefined,
    204,
  );
  await limited.error(
    'GET',
    '/api/v1/profile',
    undefined,
    401,
    'auth.unauthorized',
  );
  const { client: replacement } = await client.agent();
  await replacement.json(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Replacement credential Lab' },
    201,
  );
  await client.error(
    'POST',
    '/api/v1/api-keys',
    { name: 'Unknown scope', scopes: ['unknown'], expires_in_days: 1 },
    400,
    'api_keys.invalid_input',
  );
});

test('CORE-06 member permissions, last Owner, membership CAS and reactivation preserve boundaries', async () => {
  const client = await member();
  const id = client.session!.user.id;
  await client.error(
    'GET',
    '/api/v1/organization/members',
    undefined,
    403,
    'organization.forbidden',
  );
  const read = () =>
    owner.json<
      import('../../packages/contracts/src/generated/types.gen').MemberPage
    >('GET', '/api/v1/organization/members');
  const before = await read();
  const own = before.data.find(
    (entry) => entry.user_id === owner.session!.user.id,
  )!;
  const target = before.data.find((entry) => entry.user_id === id)!;
  await client.error(
    'PUT',
    `/api/v1/organization/members/${id}`,
    { role: 'admin', active: true, version: target.version },
    403,
    'organization.forbidden',
  );
  expect(await read()).toEqual(before);
  await owner.error(
    'PUT',
    `/api/v1/organization/members/${own.user_id}`,
    { role: 'member', active: true, version: own.version },
    422,
    'organization.last_owner',
  );
  expect(await read()).toEqual(before);
  const changed = await owner.json<
    import('../../packages/contracts/src/generated/types.gen').Member
  >('PUT', `/api/v1/organization/members/${id}`, {
    role: 'admin',
    active: true,
    version: target.version,
  });
  expect(changed.version).toBeGreaterThan(target.version);
  await owner.error(
    'PUT',
    `/api/v1/organization/members/${id}`,
    { role: 'member', active: true, version: target.version },
    409,
    'organization.version_conflict',
  );
  expect((await read()).data.find((entry) => entry.user_id === id)).toEqual(
    changed,
  );
  await client.error(
    'PUT',
    `/api/v1/organization/members/${own.user_id}`,
    { role: 'member', active: true, version: own.version },
    403,
    'organization.forbidden',
  );
  const disabled = await owner.json<
    import('../../packages/contracts/src/generated/types.gen').Member
  >('PUT', `/api/v1/organization/members/${id}`, {
    role: 'member',
    active: false,
    version: changed.version,
  });
  await client.error(
    'GET',
    '/api/v1/auth/session',
    undefined,
    401,
    'auth.unauthorized',
  );
  await owner.json('PUT', `/api/v1/organization/members/${id}`, {
    role: 'member',
    active: true,
    version: disabled.version,
  });
  await client.login(client.session!.user.email);
  expect(client.session?.user.role).toBe('member');
  await client.json(
    'POST',
    '/api/v1/lab/labs',
    { name: 'Reactivated Member Lab' },
    201,
  );
});

test('CORE-07 audit records original registration actor and rejects unauthorized/history cursor changes', async () => {
  const client = await member();
  const id = client.session!.user.id;
  await client.error(
    'GET',
    '/api/v1/audit-events',
    undefined,
    403,
    'audit.forbidden',
  );
  const page = await owner.json<
    import('../../packages/contracts/src/generated/types.gen').AuditPage
  >(
    'GET',
    `/api/v1/audit-events?action=identity.register&actor_id=${id}&limit=1`,
  );
  expect(page.data).toHaveLength(1);
  expect(page.data[0]).toMatchObject({
    actor_id: id,
    actor_type: 'user',
    action: 'identity.register',
    resource_id: id,
  });
  expect(page.data[0].request_id).toEqual(expect.any(String));
  const serialized = JSON.stringify(page);
  expect(serialized).not.toContain('contract-isolated-password');
  expect(serialized).not.toContain(client.session!.user.email);
  await owner.error(
    'GET',
    '/api/v1/audit-events?limit=101',
    undefined,
    400,
    'audit.invalid_page',
  );
  expect(
    await owner.json(
      'GET',
      `/api/v1/audit-events?action=identity.register&actor_id=${id}&limit=1`,
    ),
  ).toEqual(page);
});

test('CORE-08 normal rate policy metadata keeps main quotas, conservative overflow limits, and actual infrastructure counters', async () => {
  const metrics = await owner.json<
    import('../../packages/contracts/src/generated/types.gen').RateLimitMetrics
  >('GET', '/api/v1/system/rate-limits');
  expect(metrics.enabled).toBe(true);
  expect(metrics.window_secs).toBe(60);
  expect(metrics.local_capacity).toBe(4096);
  expect(
    metrics.policies.map(({ policy, limit, fallback_limit }) => ({
      policy,
      limit,
      fallback_limit,
    })),
  ).toEqual([
    { policy: 'registration', limit: 20, fallback_limit: 5 },
    { policy: 'authentication', limit: 60, fallback_limit: 20 },
    { policy: 'resource', limit: 600, fallback_limit: 120 },
  ]);
  if (process.env.CONTRACT_TARGET === 'rust') {
    expect(metrics.redis_configured).toBe(true);
    expect(metrics.policies.every((policy) => policy.fallbacks === 0)).toBe(
      true,
    );
    expect(metrics.policies.some((policy) => policy.redis_allowed > 0)).toBe(
      true,
    );
  } else {
    expect(metrics.redis_configured).toBe(false);
    for (const policy of metrics.policies) {
      expect(policy.redis_allowed).toBe(0);
      expect(policy.redis_denied).toBe(0);
    }
    expect(metrics.policies.some((policy) => policy.local_allowed > 0)).toBe(
      true,
    );
  }
});
