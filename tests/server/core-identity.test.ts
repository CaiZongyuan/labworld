import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { CurrentSession } from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';

test('first registration creates the Owner and a persistent HTTP-only session', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const registered = await fetch(`${target.url}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: target.url },
      body: JSON.stringify({
        email: ' Learner@Example.test ',
        password: 'a-long-test-password',
        display_name: '学习者',
      }),
    });
    assert.equal(registered.status, 201);
    const requestId = registered.headers.get('x-request-id');
    const measured = await until(
      async () =>
        target.logs.split('\n').flatMap((line) => {
          try {
            const event = JSON.parse(line) as {
              event: string;
              id: string;
              kind: string;
              commands: string[];
            };
            return event.event === 'database.operation' &&
              event.id === requestId &&
              event.kind === 'request'
              ? [event]
              : [];
          } catch {
            return [];
          }
        }),
      (rows) => rows.length > 0,
    );
    assert.equal(measured.length, 1);
    assert.equal(
      measured[0].commands.filter((command) => command === 'BEGIN').length,
      2,
    );
    assert.equal(
      measured[0].commands.filter((command) => command === 'COMMIT').length,
      2,
    );
    const cookie = registered.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    const identity = (await registered.json()) as CurrentSession;
    assert.equal(identity.user.role, 'owner');
    assert.equal(identity.user.email, 'Learner@Example.test');
    assert.equal(identity.user.display_name, '学习者');
    const session = await fetch(`${target.url}/api/v1/auth/session`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get('cache-control'), 'no-store');
    const read = (await session.json()) as CurrentSession;
    assert.deepEqual(read.user, identity.user);
    assert.equal(read.csrf_token === identity.csrf_token, true);
    await target.stop();
    await target.start();
    const reopened = await fetch(`${target.url}/api/v1/auth/session`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(reopened.status, 200);
    const persisted = (await reopened.json()) as CurrentSession;
    assert.deepEqual(persisted.user, identity.user);
    assert.equal(persisted.csrf_token === identity.csrf_token, true);
  } finally {
    await target.cleanup();
  }
});

test('an incomplete JSON body returns the retained timeout without creating an account', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  let client: ReturnType<typeof httpRequest> | undefined;
  try {
    await target.start();
    const result = await new Promise<{ status: number; code?: string }>(
      (resolve, reject) => {
        client = httpRequest(
          `${target.url}/api/v1/auth/register`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: target.url,
              'transfer-encoding': 'chunked',
            },
          },
          (response) => {
            let body = '';
            response.on('data', (chunk) => {
              body += String(chunk);
            });
            response.on('end', () =>
              resolve({
                status: response.statusCode!,
                code: JSON.parse(body).error?.code,
              }),
            );
          },
        );
        client.on('error', reject);
        client.setTimeout(6000, () => {
          resolve({ status: 0 });
          client!.destroy();
        });
        client.write(
          '{"email":"slow@example.test","password":"a-long-test-password"',
        );
      },
    );
    assert.equal(result.status, 408);
    assert.equal(result.code, 'http.body_timeout');
    assert.ok(client);
    client.end('}');
    const recovered = await fetch(`${target.url}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: target.url },
      body: JSON.stringify({
        email: 'slow@example.test',
        password: 'a-long-test-password',
      }),
    });
    assert.equal(recovered.status, 201);
    assert.equal(
      ((await recovered.json()) as CurrentSession).user.role,
      'owner',
    );
  } finally {
    client?.destroy();
    await target.cleanup();
  }
});

test('invalid JSON, byte limits, malformed cookies and wrong methods preserve the identity boundary', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const input = {
      email: 'valid@example.test',
      password: 'a-long-test-password',
    };
    for (const [body, status, code] of [
      [JSON.stringify({ ...input, extra: true }), 400, 'http.invalid_json'],
      ['{bad', 400, 'http.invalid_json'],
      [
        JSON.stringify({ ...input, display_name: 'x'.repeat(17000) }),
        413,
        'http.payload_too_large',
      ],
      [
        JSON.stringify({ ...input, email: `${'é'.repeat(125)}@a.co` }),
        400,
        'auth.invalid_input',
      ],
      [
        JSON.stringify({ ...input, email: 'x@a..test' }),
        400,
        'auth.invalid_input',
      ],
    ] as const) {
      const response = await fetch(`${target.url}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: target.url },
        body,
      });
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    }
    for (const [method, path] of [
      ['GET', '/api/v1/auth/register'],
      ['DELETE', '/api/v1/auth/login'],
      ['POST', '/api/v1/auth/session'],
    ] as const) {
      const response = await fetch(target.url + path, { method });
      assert.equal(response.status, 405);
      assert.equal(
        (await response.json()).error.code,
        'http.method_not_allowed',
      );
    }
    const registered = await fetch(`${target.url}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: target.url },
      body: JSON.stringify(input),
    });
    assert.equal(registered.status, 201);
    assert.equal(
      ((await registered.json()) as CurrentSession).user.role,
      'owner',
    );
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    const malformed = await fetch(`${target.url}/api/v1/auth/session`, {
      headers: { cookie: `${cookie}=junk` },
    });
    assert.equal(malformed.status, 401);
    assert.equal((await malformed.json()).error.code, 'auth.unauthorized');
    const retained = await fetch(`${target.url}/api/v1/auth/session`, {
      headers: { cookie },
    });
    assert.equal(retained.status, 200);
    assert.equal(
      ((await retained.json()) as CurrentSession).user.email,
      input.email,
    );
  } finally {
    await target.cleanup();
  }
});

test('CSRF and foreign origin refusals preserve the session; valid logout revokes it', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const registered = await fetch(`${target.url}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: target.url },
      body: JSON.stringify({
        email: 'logout@example.test',
        password: 'a-long-test-password',
      }),
    });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    const session = (await registered.json()) as CurrentSession;
    for (const extra of [
      { 'x-csrf-token': '' },
      { origin: 'https://untrusted.test' },
    ]) {
      const rejected = await fetch(`${target.url}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          cookie,
          origin: target.url,
          'x-csrf-token': session.csrf_token,
          ...extra,
        },
      });
      assert.equal(rejected.status, 403);
      assert.equal(
        (await rejected.json()).error.code,
        'origin' in extra ? 'auth.origin' : 'auth.csrf',
      );
      const retained = await fetch(`${target.url}/api/v1/auth/session`, {
        headers: { cookie },
      });
      assert.equal(retained.status, 200);
      const value = (await retained.json()) as CurrentSession;
      assert.deepEqual(value.user, session.user);
      assert.equal(value.csrf_token === session.csrf_token, true);
    }
    const bearer = await fetch(`${target.url}/api/v1/auth/session`, {
      headers: { cookie, authorization: 'Bearer invalid' },
    });
    assert.equal(bearer.status, 401);
    assert.equal((await bearer.json()).error.code, 'auth.unauthorized');
    const logout = await fetch(`${target.url}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        cookie,
        origin: target.url,
        'x-csrf-token': session.csrf_token,
      },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    const repeated = await fetch(`${target.url}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        cookie,
        origin: target.url,
        'x-csrf-token': session.csrf_token,
      },
    });
    assert.equal(repeated.status, 204);
    assert.match(repeated.headers.get('set-cookie')!, /Max-Age=0/);
    const revoked = await fetch(`${target.url}/api/v1/auth/session`, {
      headers: { cookie },
    });
    assert.equal(revoked.status, 401);
    assert.equal((await revoked.json()).error.code, 'auth.unauthorized');
  } finally {
    await target.cleanup();
  }
});

test('duplicate DTO fields and malformed Unicode fail before account creation while valid Unicode pairs survive', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    for (const body of [
      '{"email":"first@example.test","email":"second@example.test","password":"a-long-test-password"}',
      '{"email":"first@example.test","\\u0065mail":"second@example.test","password":"a-long-test-password"}',
      '{"email":"scalar@example.test","password":"a-long-test-password","display_name":"\\ud800"}',
      '{"email":"bad\\ud800@example.test","password":"a-long-test-password"}',
      '{"email":"scalar@example.test","password":"a-long-test-password","display_name":"\\udc00"}',
    ]) {
      const response = await fetch(`${target.url}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: target.url },
        body,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'http.invalid_json');
      assert.equal(response.headers.has('set-cookie'), false);
    }
    const valid = await fetch(`${target.url}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: target.url },
      body: JSON.stringify({
        email: '用户@例子.广告',
        password: '🔬'.repeat(12),
        display_name: '🔬学习者',
      }),
    });
    assert.equal(valid.status, 201);
    const identity = (await valid.json()) as CurrentSession;
    assert.equal(identity.user.role, 'owner');
    assert.equal(identity.user.display_name, '🔬学习者');
  } finally {
    await target.cleanup();
  }
});

test('normalized duplicate registration preserves the original password and login creates a fresh session', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  const request = (path: string, body: unknown) =>
    fetch(`${target.url}/api/v1/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: target.url },
      body: JSON.stringify(body),
    });
  try {
    await target.start();
    const registered = await request('register', {
      email: 'Original@Example.test',
      password: 'original-long-password',
    });
    assert.equal(registered.status, 201);
    const originalCookie = registered.headers.get('set-cookie');
    const original = (await registered.json()) as CurrentSession;
    const duplicate = await request('register', {
      email: ' ORIGINAL@EXAMPLE.TEST ',
      password: 'different-long-password',
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'auth.email_exists');
    const wrong = await request('login', {
      email: original.user.email,
      password: 'different-long-password',
    });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error.code, 'auth.invalid_credentials');
    const login = await request('login', {
      email: ' ORIGINAL@EXAMPLE.TEST ',
      password: 'original-long-password',
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('set-cookie') !== originalCookie, true);
    assert.deepEqual(
      ((await login.json()) as CurrentSession).user,
      original.user,
    );
    const later = await request('register', {
      email: 'second@example.test',
      password: 'another-long-password',
    });
    assert.equal(later.status, 201);
    assert.equal(((await later.json()) as CurrentSession).user.role, 'member');
  } finally {
    await target.cleanup();
  }
});
