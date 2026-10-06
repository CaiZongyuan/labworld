import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentSession } from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess } from '../support/server-process.ts';

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
    assert.deepEqual(await session.json(), identity);
    await target.stop();
    await target.start();
    const reopened = await fetch(`${target.url}/api/v1/auth/session`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(reopened.status, 200);
    assert.deepEqual(await reopened.json(), identity);
  } finally {
    await target.cleanup();
  }
});
