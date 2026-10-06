import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import {
  LocalLimiter,
  defaultRateOptions,
} from '../../packages/server/src/core/rate-limit/domain.ts';

test('necessary pure capacity proof uses bounded shared overflow quotas and reclaims buckets at the next monotonic window', () => {
  let now = 59900;
  const limiter = new LocalLimiter(
    { ...defaultRateOptions, capacity: 1 },
    () => now,
  );
  assert.equal(limiter.consume('GET', '/health/live', 'health'), undefined);
  assert.equal(limiter.consume('GET', '/profile', 'resident'), undefined);
  for (const [method, path, limit] of [
    ['POST', '/api/v1/auth/register', 5],
    ['POST', '/api/v1/auth/login', 20],
    ['GET', '/api/v1/profile', 120],
  ] as const) {
    for (let count = 0; count < limit; count++)
      assert.equal(
        limiter.consume(method, path, `overflow-${count}`),
        undefined,
      );
    assert.equal(limiter.consume(method, path, 'one-more-peer'), 1);
  }
  const before = limiter.metrics();
  assert.equal(before.local_entries, 1);
  assert.deepEqual(
    before.policies.map((p) => [p.local_allowed, p.local_denied, p.fallbacks]),
    [
      [5, 1, 6],
      [20, 1, 21],
      [121, 1, 121],
    ],
  );
  now = 60000;
  assert.equal(
    limiter.consume('GET', '/api/v1/profile', 'new-resident'),
    undefined,
  );
  for (let count = 1; count < 600; count++)
    assert.equal(
      limiter.consume('GET', '/api/v1/profile', 'new-resident'),
      undefined,
    );
  assert.equal(limiter.consume('GET', '/api/v1/profile', 'new-resident'), 60);
  assert.equal(limiter.metrics().local_entries, 1);
  const disabled = new LocalLimiter(
    { ...defaultRateOptions, enabled: false },
    () => now,
  );
  for (let count = 0; count < 1000; count++)
    assert.equal(disabled.consume('GET', '/api/v1/profile', 'peer'), undefined);
  assert.deepEqual(disabled.metrics(), {
    enabled: false,
    redis_configured: false,
    window_secs: 0,
    local_entries: 0,
    local_capacity: 0,
    policies: [],
  });
});
for (const [path, capacity, status] of [
  ['/api/v1/auth/register', 20, 400],
  ['/api/v1/auth/login', 60, 400],
  ['/api/v1/profile', 600, 401],
] as const)
  test(`primary local quota${capacity} denies quota+1, ignores forwarded headers and recovers a new window`, async () => {
    const target = await new ServerProcess().create();
    target.env.APP_ORIGIN = target.url;
    target.env.RATE_LIMIT_WINDOW_SECS = '5';
    try {
      await target.start();
      const client = new CoreHttp(target.url);
      const request = () =>
        client.response(
          path.includes('/auth/') ? 'POST' : 'GET',
          path,
          path.includes('/auth/') ? {} : undefined,
          {
            'x-forwarded-for': crypto.randomUUID(),
            forwarded: 'for=192.0.2.1',
          },
        );
      let denied: Response | undefined;
      for (let count = 0; count < capacity * 4; count++) {
        const response = await request();
        if (response.status === 429) {
          denied = response;
          break;
        }
        assert.equal(response.status, status);
        await response.arrayBuffer();
      }
      assert.ok(denied);
      await denied.arrayBuffer();
      const first = await until(
        request,
        (response) => response.status !== 429,
        15000,
      );
      assert.equal(first.status, status);
      await first.arrayBuffer();
      for (let count = 1; count < capacity; count++) {
        const response = await request();
        assert.equal(response.status, status);
        await response.arrayBuffer();
      }
      const quota = await request();
      assert.equal(quota.status, 429);
      const seconds = Number(quota.headers.get('retry-after'));
      assert.equal(seconds > 0 && seconds <= 5, true);
      const error = await quota.json();
      assert.equal(error.error.code, 'rate_limit.exceeded');
      assert.equal(error.error.details.retry_after_seconds, String(seconds));
      assert.equal((await client.response('GET', '/health/live')).status, 200);
      assert.equal((await client.response('GET', '/health/ready')).status, 200);
      const recovered = await until(
        request,
        (response) => response.status !== 429,
        15000,
      );
      assert.equal(recovered.status, status);
      await recovered.arrayBuffer();
    } finally {
      await target.cleanup();
    }
  });
test('default local metrics preserve60seconds4096buckets primary quotas and zeroRedis fields', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const owner = new CoreHttp(target.url);
    await owner.register('owner@example.test');
    const metrics = await owner.json<{
      enabled: boolean;
      window_secs: number;
      local_capacity: number;
      redis_configured: boolean;
      policies: Array<{
        policy: string;
        limit: number;
        fallback_limit: number;
        redis_allowed: number;
        redis_denied: number;
        local_allowed: number;
      }>;
    }>('GET', '/api/v1/system/rate-limits');
    assert.equal(metrics.enabled, true);
    assert.equal(metrics.window_secs, 60);
    assert.equal(metrics.local_capacity, 4096);
    assert.equal(metrics.redis_configured, false);
    assert.deepEqual(
      metrics.policies.map((row) => [
        row.policy,
        row.limit,
        row.fallback_limit,
      ]),
      [
        ['registration', 20, 5],
        ['authentication', 60, 20],
        ['resource', 600, 120],
      ],
    );
    assert.equal(
      metrics.policies.every(
        (row) => row.redis_allowed === 0 && row.redis_denied === 0,
      ),
      true,
    );
    assert.equal(
      metrics.policies.some((row) => row.local_allowed > 0),
      true,
    );
  } finally {
    await target.cleanup();
  }
});
