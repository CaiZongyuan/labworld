import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

// Approved #88 asset version append: schema 7. All prior migration
// identities remain immutable; these expectations are literals,
// independent of the running build's schemaVersion calculation.
const approvedHistory = [
  {
    hash: '1385b5d42f0f497877192ba56d953fc1864948a165946061ff15adaad3c92e53',
    created_at: '1791273889002',
  },
  {
    hash: '928c1425e0f1cbd82cd7224c66cc5d196a9d59d1497691c04186d1401f5d6034',
    created_at: '1791436317560',
  },
  {
    hash: '598fc65ec18fc2054c56c73c00c85b202c7082443df80f3cb3bb404735e70495',
    created_at: '1791665433443',
  },
  {
    hash: '63c83437ec7487eb4797a902288fae41f007dbf3fe4be7ec03f2698790129e7c',
    created_at: '1791681569129',
  },
  {
    hash: '39d30ede089dd4b438edd9968526354f99a78842eb5c1f465ba5fbfffbb33fa3',
    created_at: '1791844297546',
  },
  {
    hash: '443bbf6e2485d219ea4c6a9e528c9a29f1339aecdf47de1a9eeb51bb65d1df80',
    created_at: '1791936000000',
  },
  {
    hash: '097ec2602703c9dabcd14dc72e806887f21bb1214343573fb1d6291c8901c787',
    created_at: '1791936000006',
  },
];

test(
  'the immutable baseline and approved append migrate once and preserve identity and applied history across startup and reopening',
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
      const journal = JSON.parse(
        await readFile(
          new URL(
            '../../packages/server/migrations/meta/_journal.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      assert.deepEqual(journal.entries.at(-1), {
        idx: 6,
        version: '7',
        when: 1791936000006,
        tag: '0006_asset_versions',
        breakpoints: true,
      });
      assert.equal(
        createHash('sha256')
          .update(
            await readFile(
              new URL(
                '../../packages/server/migrations/0006_asset_versions.sql',
                import.meta.url,
              ),
            ),
          )
          .digest('hex'),
        approvedHistory[6].hash,
      );
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
        schemaVersion: 7,
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
      assert.equal(status.schema_version, 7);
      await target.stop();
      const first = await history('baseline.first-history');
      assert.equal(first.length, 7);
      assert.deepEqual(first, approvedHistory);
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
