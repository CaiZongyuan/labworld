import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

test(
  'a single baseline migrates once and preserves identity and applied history across startup and reopening',
  { timeout: 90000 },
  async () => {
    const target = await new ServerProcess().create();
    target.env = { APP_ORIGIN: target.url, RATE_LIMIT_ENABLED: 'false' };
    async function history(name: string) {
      let lease: DirectoryLease | undefined, db: Database | undefined;
      let rows: { hash: string; created_at: string }[] = [];
      await target.startInProcess(
        name,
        async () => {
          lease = await DirectoryLease.acquire(target.directory);
          db = new Database(lease);
          try {
            await db.openExisting();
            // Necessary persisted-migration supplement; identity stays at HTTP.
            rows = await db.readSQL<{ hash: string; created_at: string }>(
              { id: name, kind: 'startup', budget: 1 },
              'select hash,created_at::text from drizzle.__drizzle_migrations order by created_at',
            );
          } finally {
            try {
              await db.close();
            } finally {
              await lease.release();
              lease = undefined;
            }
          }
        },
        async () => {
          try {
            await db?.close();
          } finally {
            await lease?.release();
          }
        },
      );
      return rows;
    }
    try {
      target.entry = 'apps/server/src/cli.ts';
      target.args = ['migrate'];
      await target.spawn();
      assert.equal(
        await until(
          async () => target.child!.exitCode,
          (code) => code !== null,
        ),
        0,
        target.logs,
      );
      assert.deepEqual(JSON.parse(target.logs.trim()), {
        status: 'migrated',
        schemaVersion: 1,
      });
      await target.stop();
      target.entry = 'apps/server/src/main.ts';
      target.args = [];
      await target.start();
      const client = new CoreHttp(target.url);
      const identity = await client.register('baseline@example.test');
      const status = await client.json<{ schema_version: number }>(
        'GET',
        '/api/v1/system/status',
      );
      assert.equal(status.schema_version, 1);
      await target.stop();
      const first = await history('baseline.first-history');
      assert.equal(first.length, 1);
      await target.start();
      assert.equal(
        (await new CoreHttp(target.url).login('baseline@example.test')).user.id,
        identity.user.id,
      );
      await target.stop();
      assert.deepEqual(await history('baseline.reopened-history'), first);
    } finally {
      await target.cleanup();
    }
  },
);
