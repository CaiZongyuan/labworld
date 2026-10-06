import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ServerProcess } from '../support/server-process.ts';

test('live HTTP process reports the retained health response', async () => {
  const target = await new ServerProcess().create();
  try {
    await target.start();
    const response = await fetch(`${target.url}/health/live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await target.cleanup();
  }
});

test('real TCP readiness/status report actual migrations/version and retain errors/request correlation', async () => {
  const target = await new ServerProcess().create();
  try {
    await target.start();
    assert.equal((await fetch(`${target.url}/health/ready`)).status, 200);
    const status = (await (
      await fetch(`${target.url}/api/v1/system/status`)
    ).json()) as {
      status: string;
      service: string;
      database: string;
      schema_version: number;
      version: string;
    };
    assert.deepEqual(status, {
      status: 'ok',
      service: 'labos-threejs-api',
      database: 'connected',
      schema_version: JSON.parse(
        readFileSync('packages/server/migrations/meta/_journal.json', 'utf8'),
      ).entries.length,
      version: JSON.parse(readFileSync('apps/server/package.json', 'utf8'))
        .version,
    });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${target.url}/not-a-route`, {
        headers: { 'x-request-id': 'untrusted-fixed-id' },
      });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = (await response.json()) as {
        error: {
          code: string;
          details: Record<string, string>;
          message: string;
          request_id: string;
        };
      };
      assert.equal(body.error.code, 'http.not_found');
      assert.equal(body.error.message, 'Resource not found');
      assert.deepEqual(body.error.details, {});
      assert.equal(body.error.request_id, response.headers.get('x-request-id'));
      assert.notEqual(body.error.request_id, 'untrusted-fixed-id');
      ids.push(body.error.request_id);
    }
    assert.notEqual(ids[0], ids[1]);
    const method = await fetch(`${target.url}/health/live`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(
      ((await method.json()) as { error: { code: string } }).error.code,
      'http.method_not_allowed',
    );
  } finally {
    await target.cleanup();
  }
});

test(
  'real TCP readiness and status return 503 when the actual database is closed',
  { timeout: 60000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'tests/support/spike-process.ts';
    try {
      await target.start();
      assert.equal(
        (
          await fetch(`${target.url}/proof/database-unavailable`, {
            method: 'POST',
          })
        ).status,
        200,
      );
      for (const path of ['/health/ready', '/api/v1/system/status']) {
        const response = await fetch(target.url + path);
        assert.equal(response.status, 503);
        const body = (await response.json()) as {
          error: {
            code: string;
            request_id: string;
            details: Record<string, string>;
          };
        };
        assert.equal(body.error.code, 'database.unavailable');
        assert.equal(
          body.error.request_id,
          response.headers.get('x-request-id'),
        );
        assert.deepEqual(body.error.details, {});
      }
      assert.equal((await fetch(`${target.url}/health/live`)).status, 200);
    } finally {
      await target.cleanup();
    }
  },
);
