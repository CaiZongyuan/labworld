import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
import { copyDatabaseSnapshot } from '../../packages/server/src/platform/db/snapshot.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

async function command(directory: string, args: string[], expected: number) {
  const child = await new ServerProcess().create();
  child.entry = 'apps/server/src/cli.ts';
  child.args = args;
  child.env = { LAB_WORD_DATA_DIR: directory };
  try {
    await child.spawn();
    const code = await until(
      async () => child.child!.exitCode,
      (value) => value !== null,
      60000,
    );
    assert.equal(code, expected, child.logs);
    return JSON.parse(child.logs.trim()) as {
      status?: string;
      error?: { message: string };
    };
  } finally {
    await child.cleanup();
  }
}

test(
  'internal.archive-history: actual earlier Node history is refused without migration or target creation and a current archive recovers',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      legacy = await new ServerProcess().create(),
      target = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create();
    source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
    const archive = join(artifacts.directory, 'archive'),
      olderMigrations = join(artifacts.directory, 'older-migrations'),
      destination = join(target.directory, 'restored');
    target.env = {
      APP_ORIGIN: target.url,
      RATE_LIMIT_ENABLED: 'false',
      LAB_WORD_DATA_DIR: destination,
    };
    let lease: DirectoryLease | undefined, db: Database | undefined;
    try {
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-history@example.test',
      );
      await source.stop();
      await command(source.directory, ['backup', '--output', archive], 0);
      const originalManifest = await readFile(
        join(archive, 'manifest.json'),
        'utf8',
      );
      const journal = JSON.parse(
        await readFile('packages/server/migrations/meta/_journal.json', 'utf8'),
      );
      await mkdir(join(olderMigrations, 'meta'), { recursive: true });
      await writeFile(
        join(olderMigrations, 'meta', '_journal.json'),
        JSON.stringify({ ...journal, entries: [journal.entries[0]] }),
      );
      await copyFile(
        'packages/server/migrations/0000_foundation.sql',
        join(olderMigrations, '0000_foundation.sql'),
      );
      // Necessary historical setup through the existing platform migration API;
      // no table seed, private SQL write or production test route.
      await legacy.startInProcess(
        'actual earlier Node migration fixture',
        async () => {
          lease = await DirectoryLease.acquire(legacy.directory);
          db = new Database(lease);
          await assert.rejects(
            db.initialize(olderMigrations),
            /Applied migrations do not match/,
          );
        },
        async () => {
          try {
            await db?.close();
          } finally {
            await lease?.release();
            lease = undefined;
          }
        },
      );
      const before = await db!.readSQL<{ hash: string; created_at: string }>(
        { id: 'internal.archive-history.before', kind: 'startup', budget: 1 },
        'select hash,created_at::text from drizzle.__drizzle_migrations order by created_at',
      );
      assert.equal(
        before.length,
        1,
        'genuine earlier Node applied history has only the original migration',
      );
      await db!.close();
      const legacySnapshot = join(artifacts.directory, 'legacy-pgdata');
      await copyDatabaseSnapshot(lease!, legacySnapshot);
      await lease!.release();
      lease = undefined;
      const refusal = await command(
        legacy.directory,
        ['backup', '--output', join(artifacts.directory, 'legacy-backup')],
        1,
      );
      assert.match(
        refusal.error!.message,
        /Unsupported Node migration history/,
      );
      await assert.rejects(lstat(join(artifacts.directory, 'legacy-backup')), {
        code: 'ENOENT',
      });
      lease = await DirectoryLease.acquire(legacy.directory);
      db = new Database(lease);
      await db.openExisting();
      assert.deepEqual(
        await db.readSQL(
          { id: 'internal.archive-history.after', kind: 'startup', budget: 1 },
          'select hash,created_at::text from drizzle.__drizzle_migrations order by created_at',
        ),
        before,
        'unsupported backup did not convert or replace the historical ledger',
      );
      await db.close();
      await lease.release();
      lease = undefined;
      const saved = join(artifacts.directory, 'current-pgdata');
      await rename(join(archive, 'pgdata'), saved);
      await rename(legacySnapshot, join(archive, 'pgdata'));
      const manifest = JSON.parse(originalManifest);
      manifest.directories = [];
      manifest.entries = [];
      manifest.readyFiles = [];
      async function collect(prefix: string) {
        manifest.directories.push(prefix);
        for (const name of await readdir(join(archive, prefix))) {
          const path = prefix + '/' + name,
            info = await lstat(join(archive, path));
          if (info.isDirectory()) await collect(path);
          else {
            const bytes = await readFile(join(archive, path));
            manifest.entries.push({
              path,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            });
          }
        }
      }
      await collect('pgdata');
      await writeFile(join(archive, 'manifest.json'), JSON.stringify(manifest));
      const rejected = await command(
        destination,
        ['restore', '--archive', archive],
        1,
      );
      assert.match(
        rejected.error!.message,
        /Unsupported Node migration history/,
      );
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      await rename(join(archive, 'pgdata'), legacySnapshot);
      await rename(saved, join(archive, 'pgdata'));
      await writeFile(join(archive, 'manifest.json'), originalManifest);
      await command(destination, ['restore', '--archive', archive], 0);
      await target.start();
      assert.equal(
        (await new CoreHttp(target.url).login('archive-history@example.test'))
          .user.id,
        session.user.id,
      );
    } finally {
      await Promise.all([
        source.cleanup(),
        legacy.cleanup(),
        target.cleanup(),
        artifacts.cleanup(),
      ]);
    }
  },
);
