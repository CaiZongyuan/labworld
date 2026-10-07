import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
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

async function cli(
  directory: string,
  args: string[],
  expectedExit = 0,
  fault?: { input: string; alternate: string; report: string },
) {
  const actor = await new ServerProcess().create();
  actor.entry = fault
    ? 'tests/support/archive-copy-fault.ts'
    : 'apps/server/src/cli.ts';
  actor.args = args;
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
      const refusal = await cli(
        source.directory,
        ['backup', '--output', invalid],
        1,
      );
      assert.match((refusal.error as { message: string }).message, /overlap/i);
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
