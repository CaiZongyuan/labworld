import { expect, test } from 'vitest';
import { HttpClient, until } from './http';

for (const [id, path, capacity, status] of [
  ['RATE-01', '/api/v1/auth/register', 20, 400],
  ['RATE-02', '/api/v1/auth/login', 60, 400],
  ['RATE-03', '/api/v1/profile', 600, 401],
] as const)
  test(`${id} normal primary quota ${capacity} rejects quota+1 with Retry-After and a new window recovers`, async () => {
    const client = new HttpClient();
    const request = () =>
      client.response(
        path.includes('/auth/') ? 'POST' : 'GET',
        path,
        path.includes('/auth/') ? {} : undefined,
      );
    // Observe the end of a real window, then count from its first admitted request.
    let denied: Response | undefined;
    for (let count = 0; count < capacity * 4; count++) {
      const response = await request();
      if (response.status === 429) {
        denied = response;
        break;
      }
      expect(response.status).toBe(status);
      await response.arrayBuffer();
    }
    expect(denied).toBeDefined();
    expect(Number(denied!.headers.get('retry-after'))).toBeGreaterThan(0);
    const envelope = await denied!.json();
    expect(envelope.error.code).toBe('rate_limit.exceeded');
    expect(envelope.error.request_id).toEqual(expect.any(String));
    expect((await client.response('GET', '/health/live')).status).toBe(200);
    expect((await client.response('GET', '/health/ready')).status).toBe(200);
    const first = await until(
      request,
      (response) => response.status !== 429,
      15_000,
    );
    expect(first.status).toBe(status);
    await first.arrayBuffer();
    for (let count = 1; count < capacity; count++) {
      const response = await request();
      expect(response.status, `admitted request ${count + 1}/${capacity}`).toBe(
        status,
      );
      await response.arrayBuffer();
    }
    const quotaPlusOne = await request();
    expect(quotaPlusOne.status).toBe(429);
    const retryAfter = Number(quotaPlusOne.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(5);
    const rejected = await quotaPlusOne.json();
    expect(rejected.error.details.retry_after_seconds).toBe(String(retryAfter));
    const recovered = await until(
      request,
      (response) => response.status !== 429,
      15_000,
    );
    expect(recovered.status).toBe(status);
    await recovered.arrayBuffer();
  });
