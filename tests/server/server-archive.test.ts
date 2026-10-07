import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

async function cli(directory: string, args: string[]) {
  const actor = await new ServerProcess().create();
  actor.entry = 'apps/server/src/cli.ts';
  actor.args = args;
  actor.env = { LAB_WORD_DATA_DIR: directory };
  try {
    await actor.spawn();
    const code = await until(
      async () => actor.child!.exitCode,
      (value) => value !== null,
      60000,
    );
    assert.equal(
      code,
      0,
      'CLI ' + args[0] + ' did not complete: ' + actor.logs,
    );
    return JSON.parse(actor.logs.trim()) as Record<string, unknown>;
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
