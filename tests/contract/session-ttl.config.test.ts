import { expect, test } from 'vitest';
import { HttpClient, member, until } from './http';
import { createLab } from './lab';
import { WorldStream } from './sse';

test('SESSION-01 configured idle and absolute expiration end access; activity cannot extend absolute life and new login recovers', async () => {
  const client = await member();
  const lab = (await createLab(client, 'Session expiry')).id;
  const stream = await WorldStream.open(client, lab);
  try {
    expect((await stream.next())?.type).toBe('snapshot');
    expect(await stream.event('access_ended')).toEqual({
      type: 'access_ended',
    });
    expect(await stream.next()).toBeUndefined();
    await client.error(
      'GET',
      '/api/v1/auth/session',
      undefined,
      401,
      'auth.unauthorized',
    );
    await client.error(
      'GET',
      `/api/v1/lab/labs/${lab}/world`,
      undefined,
      401,
      'auth.unauthorized',
    );
  } finally {
    stream.close();
  }
  await client.login(client.session!.user.email);
  const started = Date.now();
  const expired = await until(
    async () => {
      const response = await client.response('GET', '/api/v1/auth/session');
      await response.arrayBuffer();
      return response.status;
    },
    (status) => status === 401,
    10_000,
    500,
  );
  expect(expired).toBe(401);
  expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
  const replacement = new HttpClient();
  await replacement.login(client.session!.user.email);
  const recovered = await WorldStream.open(replacement, lab);
  try {
    expect((await recovered.next())?.type).toBe('snapshot');
  } finally {
    recovered.close();
  }
});
