import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { backup } from '../../apps/server/src/operations.ts';
import type {
  CreatedApiKey,
  DeviceCommand,
  DeviceProgramRun,
  DownloadCapability,
  LabEntity,
  PersistentLab,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';

test('internal.archive-path: an unavailable filesystem root preserves its error and ends ancestor fallback', async (t) => {
  const missing = Object.assign(new Error('Unavailable filesystem root'), {
    code: 'ENOENT',
  });
  let roots = 0;
  t.mock.method(fs, 'realpath', async (path: string) => {
    if (dirname(path) === path && ++roots > 1)
      throw new Error('Probe prevented repeated root fallback');
    throw missing;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      backup('/missing-source', '/missing-output'),
      (error) => error === missing,
    );
    assert.equal(roots, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

async function treeState(root: string): Promise<unknown[]> {
  const state: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name),
      info = await lstat(path);
    state.push(
      info.isDirectory()
        ? [name, info.mode, await treeState(path)]
        : [
            name,
            info.mode,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ],
    );
  }
  return state;
}

async function cli(
  directory: string,
  args: string[],
  expectedExit = 0,
  fault?: { input: string; alternate: string; report: string },
  input?: string,
) {
  const actor = await new ServerProcess().create();
  actor.entry = fault
    ? 'tests/support/archive-copy-fault.ts'
    : 'apps/server/src/cli.ts';
  actor.args = args;
  actor.input = input;
  actor.env = {
    LAB_WORD_DATA_DIR: directory,
    ...(fault
      ? {
          ARCHIVE_FAULT_INPUT: fault.input,
          ARCHIVE_FAULT_ALTERNATE: fault.alternate,
          ARCHIVE_FAULT_REPORT: fault.report,
        }
      : {}),
  };
  try {
    await actor.spawn();
    const code = await until(
      async () => actor.child!.exitCode,
      (value) => value !== null,
      60000,
    );
    assert.equal(
      code,
      expectedExit,
      'CLI ' + args[0] + ' returned an unexpected exit: ' + actor.logs,
    );
    const reply = actor.logs
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => 'status' in row || 'error' in row);
    assert.ok(reply, 'CLI returned a structured result');
    return reply;
  } finally {
    await actor.cleanup();
  }
}

test(
  'offline CLI backup and new-directory restore preserve identity, verified bytes and an acknowledged Command without replay',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      restored = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create();
    source.env = {
      APP_ORIGIN: source.url,
      FILE_PUBLIC_ORIGIN: source.url,
      RATE_LIMIT_ENABLED: 'false',
    };
    const destination = join(restored.directory, 'restored'),
      archive = join(artifacts.directory, 'archive');
    restored.env = {
      APP_ORIGIN: restored.url,
      FILE_PUBLIC_ORIGIN: restored.url,
      RATE_LIMIT_ENABLED: 'false',
      LAB_WORD_DATA_DIR: destination,
    };
    let failed = false,
      originalError: unknown,
      cleanupErrors: unknown[];
    try {
      await source.start();
      const member = new CoreHttp(source.url),
        session = await member.register('archive-owner@example.test'),
        key = await member.json<CreatedApiKey>(
          'POST',
          '/api/v1/api-keys',
          {
            name: 'Restored Agent',
            scopes: ['lab:full'],
            expires_in_days: 1,
          },
          201,
        ),
        bytes = await readFile('tests/fixtures/lab/cube.glb'),
        asset = await publishAsset(member, bytes),
        lab = await member.json<PersistentLab>(
          'POST',
          '/api/v1/lab/labs',
          { name: 'Archived real Lab' },
          201,
        ),
        entity = await member.json<LabEntity>(
          'POST',
          '/api/v1/lab/labs/' + lab.id + '/entities',
          {
            name: 'Archived light',
            definition_id: 'light',
            definition_version: '1.0',
            reality: 'simulated',
            configuration: {},
            representation_id: asset.representation.id,
          },
          201,
        ),
        path = '/api/v1/lab/labs/' + lab.id + '/entities/' + entity.id,
        run = await member.json<DeviceProgramRun>(
          'POST',
          path + '/program/start',
          undefined,
          201,
        ),
        action = { capability: 'light.set_power', parameters: { on: true } },
        command = await member.json<DeviceCommand>(
          'POST',
          path + '/actions',
          action,
          202,
          { 'idempotency-key': 'archive-acknowledged' },
        );
      const acknowledged = await until(
        () =>
          member.json<DeviceCommand>('GET', path + '/commands/' + command.id),
        (value) => value.status === 'succeeded',
      );
      await source.stop();
      const backup = await cli(source.directory, [
        'backup',
        '--output',
        archive,
      ]);
      assert.equal(backup.status, 'backed-up');
      const restore = await cli(destination, ['restore', '--archive', archive]);
      assert.equal(restore.status, 'restored');
      await restored.start();
      const reader = new CoreHttp(restored.url);
      assert.equal(
        (await reader.login('archive-owner@example.test')).user.id,
        session.user.id,
      );
      const authorization = { authorization: 'Bearer ' + key.secret },
        download = await reader.json<DownloadCapability>(
          'GET',
          '/api/v1/lab/assets/' + asset.id + '/download',
          undefined,
          200,
          authorization,
        ),
        response = await fetch(download.url);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.deepEqual(
        await reader.json<DeviceCommand>(
          'GET',
          path + '/commands/' + command.id,
        ),
        acknowledged,
      );
      assert.deepEqual(
        await reader.json<DeviceCommand>(
          'POST',
          path + '/actions',
          action,
          202,
          { 'idempotency-key': 'archive-acknowledged' },
        ),
        acknowledged,
      );
      const current = await reader.json<LabEntity>('GET', path);
      assert.equal(current.program_run!.id, run.id);
      assert.equal(current.program_run!.status, 'interrupted');
      assert.equal(current.observation!.properties.on.value, true);
      assert.ok(
        ['interrupted', 'stale'].includes(current.observation!.freshness),
        'restored last values cannot become current; expiry may occur while the service is offline',
      );
      console.log(
        JSON.stringify({
          event: 'm4.archive-cli-public',
          sourceLedger: join(source.evidence, 'owned-resources.json'),
          restoreLedger: join(restored.evidence, 'owned-resources.json'),
          artifactsLedger: join(artifacts.evidence, 'owned-resources.json'),
          identity: 'same',
          signedBytes: bytes.length,
          command: 'acknowledged-no-replay',
        }),
      );
    } catch (error) {
      failed = true;
      originalError = error;
    } finally {
      const cleanup = await Promise.allSettled([
        source.cleanup(),
        restored.cleanup(),
        artifacts.cleanup(),
      ]);
      const failures = cleanup.filter((result) => result.status === 'rejected');
      cleanupErrors = failures.map((result) => result.reason);
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(failed ? [originalError] : []), ...cleanupErrors],
        'Owned archive tracer cleanup failed',
      );
    if (failed) throw originalError;
  },
);

test(
  'restore refuses an escaping database directory link before creating the target, then a valid archive recovers',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      restored = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create();
    source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
    const archive = join(artifacts.directory, 'archive'),
      outside = join(artifacts.directory, 'outside-database'),
      destination = join(restored.directory, 'restored');
    restored.env = {
      APP_ORIGIN: restored.url,
      RATE_LIMIT_ENABLED: 'false',
      LAB_WORD_DATA_DIR: destination,
    };
    try {
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-link@example.test',
      );
      await source.stop();
      await cli(source.directory, ['backup', '--output', archive]);
      // Explicit malformed public archive fixture, never a database seed.
      await rename(join(archive, 'pgdata'), outside);
      await symlink(
        outside,
        join(archive, 'pgdata'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const refusal = await cli(
        destination,
        ['restore', '--archive', archive],
        1,
      );
      assert.match((refusal.error as { message: string }).message, /link/i);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      await unlink(join(archive, 'pgdata'));
      await rename(outside, join(archive, 'pgdata'));
      await cli(destination, ['restore', '--archive', archive]);
      await restored.start();
      assert.equal(
        (await new CoreHttp(restored.url).login('archive-link@example.test'))
          .user.id,
        session.user.id,
      );
    } finally {
      await Promise.all([
        source.cleanup(),
        restored.cleanup(),
        artifacts.cleanup(),
      ]);
    }
  },
);

test(
  'backup accepts an existing empty output in the safe data-directory backups folder and restores it',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      restored = await new ServerProcess().create();
    source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
    const archive = join(source.directory, 'backups', 'empty-output'),
      destination = join(restored.directory, 'restored');
    restored.env = {
      APP_ORIGIN: restored.url,
      RATE_LIMIT_ENABLED: 'false',
      LAB_WORD_DATA_DIR: destination,
    };
    try {
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-empty@example.test',
      );
      await source.stop();
      await mkdir(archive, { recursive: true });
      const result = await cli(source.directory, [
        'backup',
        '--output',
        archive,
      ]);
      assert.equal(result.status, 'backed-up');
      await cli(destination, ['restore', '--archive', archive]);
      await restored.start();
      assert.equal(
        (await new CoreHttp(restored.url).login('archive-empty@example.test'))
          .user.id,
        session.user.id,
      );
    } finally {
      await Promise.all([source.cleanup(), restored.cleanup()]);
    }
  },
);

test(
  'backup rejects canonical overlap with the database before opening the source, including aliases, and a safe backups folder works',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      aliases = await new ServerProcess().create();
    source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
    const database = join(source.directory, 'pgdata'),
      alias = join(aliases.directory, 'database-link'),
      invalid = join(database, 'new-backups', 'archive');
    try {
      await source.start();
      const reader = new CoreHttp(source.url),
        session = await reader.register('archive-overlap@example.test');
      await symlink(
        database,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      // The live source lease makes this missing-guard red safe: it prevents
      // the old implementation from ever reaching recursive copying.
      for (const output of [invalid, join(alias, 'new-backups', 'archive')]) {
        const refusal = await cli(
          source.directory,
          ['backup', '--output', output],
          1,
        );
        assert.match(
          (refusal.error as { message: string }).message,
          /overlap/i,
        );
      }
      await assert.rejects(lstat(join(database, 'new-backups')), {
        code: 'ENOENT',
      });
      assert.equal(
        (
          await reader.json<{ user: { id: string } }>(
            'GET',
            '/api/v1/auth/session',
          )
        ).user.id,
        session.user.id,
      );
      await source.stop();
      const before = await treeState(database);
      for (const output of [invalid, join(alias, 'new-backups', 'archive')]) {
        const refusal = await cli(
          source.directory,
          ['backup', '--output', output],
          1,
        );
        assert.match(
          (refusal.error as { message: string }).message,
          /overlap/i,
        );
      }
      assert.deepEqual(
        await treeState(database),
        before,
        'both inactive refusals preserve the full database tree and bytes',
      );
      await assert.rejects(lstat(join(database, 'new-backups')), {
        code: 'ENOENT',
      });
      assert.equal(
        (
          await cli(source.directory, [
            'backup',
            '--output',
            join(source.directory, 'backups', 'safe'),
          ])
        ).status,
        'backed-up',
      );
    } finally {
      await Promise.all([source.cleanup(), aliases.cleanup()]);
    }
  },
);

test(
  'internal.archive-copy: conflicting copied database bytes are refused before publication and the original archive recovers',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      alternate = await new ServerProcess().create(),
      restored = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create();
    source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
    alternate.env = { APP_ORIGIN: alternate.url, RATE_LIMIT_ENABLED: 'false' };
    const archive = join(artifacts.directory, 'original'),
      other = join(artifacts.directory, 'alternate'),
      report = join(artifacts.directory, 'copy-fault.json'),
      destination = join(restored.directory, 'restored');
    restored.env = {
      APP_ORIGIN: restored.url,
      RATE_LIMIT_ENABLED: 'false',
      LAB_WORD_DATA_DIR: destination,
    };
    try {
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-copy-a@example.test',
      );
      await source.stop();
      await cli(source.directory, ['backup', '--output', archive]);
      await alternate.start();
      await new CoreHttp(alternate.url).register('archive-copy-b@example.test');
      await alternate.stop();
      await cli(alternate.directory, ['backup', '--output', other]);
      const refusal = await cli(
        destination,
        ['restore', '--archive', archive],
        1,
        { input: archive, alternate: other, report },
      );
      assert.equal(
        JSON.parse(await readFile(report, 'utf8')).swapped,
        true,
        'actual filesystem copy boundary was perturbed',
      );
      assert.match(
        (refusal.error as { message: string }).message,
        /staged.*content/i,
      );
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      await cli(destination, ['restore', '--archive', archive]);
      await restored.start();
      assert.equal(
        (await new CoreHttp(restored.url).login('archive-copy-a@example.test'))
          .user.id,
        session.user.id,
      );
    } finally {
      await Promise.all([
        source.cleanup(),
        alternate.cleanup(),
        restored.cleanup(),
        artifacts.cleanup(),
      ]);
    }
  },
);

test(
  'backup refuses an active source and missing, wrong-size or wrong-hash ready bytes, then a repaired source restores',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      restored = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create();
    source.env = {
      APP_ORIGIN: source.url,
      FILE_PUBLIC_ORIGIN: source.url,
      RATE_LIMIT_ENABLED: 'false',
    };
    const archive = join(artifacts.directory, 'archive'),
      destination = join(restored.directory, 'restored');
    restored.env = {
      APP_ORIGIN: restored.url,
      FILE_PUBLIC_ORIGIN: restored.url,
      RATE_LIMIT_ENABLED: 'false',
      LAB_WORD_DATA_DIR: destination,
    };
    try {
      await source.start();
      const member = new CoreHttp(source.url);
      await member.register('archive-bytes@example.test');
      const bytes = await readFile('tests/fixtures/lab/cube.glb'),
        asset = await publishAsset(member, bytes),
        hash = createHash('sha256').update(bytes).digest('hex'),
        object = join(
          source.directory,
          'blobs',
          'objects',
          hash.slice(0, 2),
          hash,
        );
      const active = await cli(
        source.directory,
        ['backup', '--output', archive],
        1,
      );
      assert.match(
        (active.error as { message: string }).message,
        /EADDRINUSE|busy|use/i,
      );
      await assert.rejects(lstat(archive), { code: 'ENOENT' });
      const live = await member.json<DownloadCapability>(
        'GET',
        '/api/v1/lab/assets/' + asset.id + '/download',
      );
      assert.deepEqual(
        Buffer.from(await (await fetch(live.url)).arrayBuffer()),
        bytes,
      );
      await source.stop();
      const saved = join(artifacts.directory, 'ready-original');
      await rename(object, saved);
      await cli(source.directory, ['backup', '--output', archive], 1);
      await assert.rejects(lstat(archive), { code: 'ENOENT' });
      await rename(saved, object);
      const wrong = Buffer.from(bytes);
      wrong[wrong.length - 1] ^= 1;
      for (const content of [Buffer.concat([bytes, Buffer.from([0])]), wrong]) {
        await writeFile(object, content);
        await cli(source.directory, ['backup', '--output', archive], 1);
        await assert.rejects(lstat(archive), { code: 'ENOENT' });
      }
      await writeFile(object, bytes);
      await cli(source.directory, ['backup', '--output', archive]);
      await cli(destination, ['restore', '--archive', archive]);
      await restored.start();
      const reader = new CoreHttp(restored.url);
      await reader.login('archive-bytes@example.test');
      const download = await reader.json<DownloadCapability>(
        'GET',
        '/api/v1/lab/assets/' + asset.id + '/download',
      );
      assert.deepEqual(
        Buffer.from(await (await fetch(download.url)).arrayBuffer()),
        bytes,
      );
    } finally {
      await Promise.all([
        source.cleanup(),
        restored.cleanup(),
        artifacts.cleanup(),
      ]);
    }
  },
);

test(
  'restore refuses malformed format, declared history, paths, missing or mismatched content and nonempty targets without mutation, then recovers',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create(),
      restored = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create();
    source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
    const archive = join(artifacts.directory, 'archive'),
      manifestPath = join(archive, 'manifest.json'),
      destination = join(restored.directory, 'restored');
    restored.env = {
      APP_ORIGIN: restored.url,
      RATE_LIMIT_ENABLED: 'false',
      LAB_WORD_DATA_DIR: destination,
    };
    try {
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-refusal@example.test',
      );
      await source.stop();
      await cli(source.directory, ['backup', '--output', archive]);
      const text = await readFile(manifestPath, 'utf8');
      type FixtureManifest = {
        format: string;
        database: { schemaVersion: number; history: Array<{ hash: string }> };
        directories: string[];
        entries: Array<{ path: string; size: number; sha256: string }>;
      };
      const mutations: Array<(value: FixtureManifest) => void> = [
        (value) => {
          value.format = 'unsupported';
        },
        (value) => {
          value.database.schemaVersion = 999;
        },
        (value) => {
          value.database.history[0].hash = '0'.repeat(64);
        },
        (value) => {
          value.entries[0].path = '../escape';
        },
        (value) => {
          value.entries[0].path = '/absolute';
        },
        (value) => {
          value.entries.push({ ...value.entries[0] });
        },
        (value) => {
          value.entries[0].size += 1;
        },
        (value) => {
          value.entries[0].sha256 = '0'.repeat(64);
        },
      ];
      for (const change of mutations) {
        const manifest = JSON.parse(text) as FixtureManifest;
        change(manifest);
        await writeFile(manifestPath, JSON.stringify(manifest));
        await cli(destination, ['restore', '--archive', archive], 1);
        await assert.rejects(lstat(destination), { code: 'ENOENT' });
      }
      await writeFile(manifestPath, '{');
      await cli(destination, ['restore', '--archive', archive], 1);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      await writeFile(manifestPath, text);
      const entry = (JSON.parse(text) as FixtureManifest).entries[0],
        path = join(archive, entry.path),
        saved = join(artifacts.directory, 'missing-entry');
      await rename(path, saved);
      await cli(destination, ['restore', '--archive', archive], 1);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      await rename(saved, path);
      await mkdir(destination);
      await writeFile(
        join(destination, 'retained.txt'),
        'Keep this destination',
      );
      const before = await treeState(destination);
      await cli(destination, ['restore', '--archive', archive], 1);
      assert.deepEqual(await treeState(destination), before);
      await unlink(join(destination, 'retained.txt'));
      await cli(destination, ['restore', '--archive', archive]);
      await restored.start();
      assert.equal(
        (await new CoreHttp(restored.url).login('archive-refusal@example.test'))
          .user.id,
        session.user.id,
      );
    } finally {
      await Promise.all([
        source.cleanup(),
        restored.cleanup(),
        artifacts.cleanup(),
      ]);
    }
  },
);

test(
  'unified migrate and password-reset CLI preserve identity and revoke old sessions through the retained HTTP contract',
  { timeout: 90000 },
  async () => {
    const source = await new ServerProcess().create();
    source.entry = 'apps/server/src/cli.ts';
    source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
    try {
      assert.equal(
        (await cli(source.directory, ['migrate'])).status,
        'migrated',
      );
      await source.start();
      const member = new CoreHttp(source.url),
        email = 'unified-command@example.test',
        session = await member.register(email);
      await source.stop();
      const replacement = 'unified-replacement-password';
      const result = await cli(
        source.directory,
        ['reset-password', '--email', email],
        0,
        undefined,
        replacement + '\n',
      );
      assert.deepEqual(result, { status: 'reset', user_id: session.user.id });
      await source.start();
      await member.error(
        'GET',
        '/api/v1/auth/session',
        undefined,
        401,
        'auth.unauthorized',
      );
      await member.error(
        'POST',
        '/api/v1/auth/login',
        { email, password: 'contract-isolated-password' },
        401,
        'auth.invalid_credentials',
      );
      assert.equal(
        (await member.login(email, replacement)).user.id,
        session.user.id,
      );
    } finally {
      await source.cleanup();
    }
  },
);
