import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  writeFile,
  lstat,
  mkdir,
  symlink,
  realpath,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
import type {
  LabWorld,
  LabEntity,
  PersistentLab,
  DeviceCommand,
  DownloadCapability,
} from '../../packages/contracts/src/generated/types.gen.ts';

test(
  'a real compressed baseline archive upgrades once with identity files and committed Command intact',
  { timeout: 90000 },
  async () => {
    const producer = await new ServerProcess().create();
    const destination = await new ServerProcess().create();
    const artifacts = await new ServerProcess().create();
    const baselineRevision = '7f8c7a8f69b922a79e62f596722b42a6c8b26d46';
    const baselineRoot = join(artifacts.directory, 'baseline-producer-source');
    const archive = join(artifacts.directory, 'baseline-archive');
    const restored = join(destination.directory, 'restored');
    async function command(
      entry: string,
      directory: string,
      args: string[],
      expected = 0,
    ) {
      const child = await new ServerProcess().create();
      child.entry = entry;
      child.env = { LAB_WORD_DATA_DIR: directory };
      child.args = args;
      try {
        await mkdir(baselineRoot);
        const source = execFileSync(
          'git',
          [
            'archive',
            '--format=tar',
            baselineRevision,
            'apps/server',
            'packages/server',
          ],
          { maxBuffer: 32 * 1024 * 1024 },
        );
        execFileSync('tar', ['-xf', '-', '-C', baselineRoot], {
          input: source,
        });
        for (const path of [
          'node_modules',
          'apps/server/node_modules',
          'packages/server/node_modules',
        ]) {
          const target = join(baselineRoot, path);
          await mkdir(join(target, '..'), { recursive: true });
          await symlink(
            await realpath(resolve(path)),
            target,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
        await child.spawn();
        const code = await until(
          async () => child.child!.exitCode,
          (value) => value !== null,
          60000,
        );
        assert.equal(
          code,
          expected,
          'Owned archive command must succeed: ' + child.logs,
        );
        return JSON.parse(child.logs.trim());
      } finally {
        console.log(
          JSON.stringify({
            event: 'guide.archive.command-ledger',
            path: child.evidence + '/owned-resources.json',
          }),
        );
        await child.cleanup();
      }
    }
    try {
      const journal = JSON.parse(
        await readFile(
          join(baselineRoot, 'packages/server/migrations/meta/_journal.json'),
          'utf8',
        ),
      );
      assert.equal(journal.entries.length, 1);
      assert.equal(journal.entries[0].tag, '0000_baseline');
      const baselineHash = createHash('sha256')
        .update(
          await readFile(
            join(baselineRoot, 'packages/server/migrations/0000_baseline.sql'),
          ),
        )
        .digest('hex');
      producer.entry = join(baselineRoot, 'apps/server/src/main.ts');
      producer.env = { APP_ORIGIN: producer.url, RATE_LIMIT_ENABLED: 'false' };
      await producer.start();
      const client = new CoreHttp(producer.url);
      const identity = await client.register(
        'baseline-guide-archive@example.test',
      );
      const bytes = await readFile('tests/fixtures/lab/cube.glb');
      const asset = await publishAsset(
        client,
        bytes,
        'Baseline archive geometry',
      );
      const lab = await client.json<PersistentLab>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Baseline preserved Lab' },
        201,
      );
      const entityPath = `/api/v1/lab/labs/${lab.id}/entities`;
      const entity = await client.json<LabEntity>(
        'POST',
        entityPath,
        {
          name: 'Preserved light',
          definition_id: 'light',
          definition_version: '1.0',
          reality: 'simulated',
          configuration: {},
          representation_id: asset.representation.id,
        },
        201,
      );
      await client.json(
        'POST',
        `${entityPath}/${entity.id}/program/start`,
        undefined,
        201,
      );
      const accepted = await client.json<DeviceCommand>(
        'POST',
        `${entityPath}/${entity.id}/actions`,
        { capability: 'light.set_power', parameters: { on: true } },
        202,
        { 'idempotency-key': randomUUID() },
      );
      const committed = await until(
        () =>
          client.json<DeviceCommand>(
            'GET',
            `${entityPath}/${entity.id}/commands/${accepted.id}`,
          ),
        (value) => value.status === 'succeeded',
      );
      await producer.stop();
      const backup = await command(
        join(baselineRoot, 'apps/server/src/cli.ts'),
        producer.directory,
        ['backup', '--output', archive],
      );
      assert.equal(backup.schemaVersion, 1);
      const originalManifest = await readFile(
        join(archive, 'manifest.json'),
        'utf8',
      );
      const manifest = JSON.parse(originalManifest);
      assert.equal(manifest.database.history.length, 1);
      assert.equal(manifest.database.history[0].hash, baselineHash);
      const corrupt = structuredClone(manifest);
      corrupt.database.history[0].hash = 'f'.repeat(64);
      await writeFile(join(archive, 'manifest.json'), JSON.stringify(corrupt));
      const refused = await command(
        'apps/server/src/cli.ts',
        restored,
        ['restore', '--archive', archive],
        1,
      );
      assert.match(
        refused.error.message,
        /Unsupported archive database history or engine/,
      );
      await assert.rejects(lstat(restored), { code: 'ENOENT' });
      await writeFile(join(archive, 'manifest.json'), originalManifest);
      const result = await command('apps/server/src/cli.ts', restored, [
        'restore',
        '--archive',
        archive,
      ]);
      assert.equal(result.schemaVersion, 2);
      destination.env = {
        APP_ORIGIN: destination.url,
        LAB_WORD_DATA_DIR: restored,
        RATE_LIMIT_ENABLED: 'false',
      };
      await destination.start();
      const member = new CoreHttp(destination.url);
      assert.equal(
        (await member.login('baseline-guide-archive@example.test')).user.id,
        identity.user.id,
      );
      const world = await member.json<LabWorld>(
        'GET',
        `/api/v1/lab/labs/${lab.id}/world`,
      );
      assert.equal(
        world.entities.find((value) => value.id === entity.id)!.name,
        'Preserved light',
      );
      assert.equal(
        world.assets.find((value) => value.id === asset.id)!.representation.id,
        asset.representation.id,
      );
      assert.deepEqual(
        await member.json<DeviceCommand>(
          'GET',
          `${entityPath}/${entity.id}/commands/${accepted.id}`,
        ),
        committed,
      );
      assert.notEqual(
        world.entities.find((value) => value.id === entity.id)!.program_run
          ?.status,
        'running',
      );
      const download = await member.json<DownloadCapability>(
        'GET',
        `/api/v1/lab/assets/${asset.id}/download`,
      );
      assert.deepEqual(
        Buffer.from(await (await fetch(download.url)).arrayBuffer()),
        bytes,
      );
      const progress = await member.json<{ progress: { revision: number } }>(
        'GET',
        '/api/v1/lab/guides/lab-onboarding/1.0/progress',
      );
      assert.equal(progress.progress.revision, 0);
      await destination.stop();
      await destination.start();
      assert.equal(
        (await member.login('baseline-guide-archive@example.test')).user.id,
        identity.user.id,
      );
      assert.equal(
        await readFile(join(archive, 'manifest.json'), 'utf8'),
        originalManifest,
      );
      await destination.stop();
      const currentArchive = join(artifacts.directory, 'current-archive');
      const currentCopy = join(artifacts.directory, 'current-copy');
      const currentBackup = await command('apps/server/src/cli.ts', restored, [
        'backup',
        '--output',
        currentArchive,
      ]);
      assert.equal(currentBackup.schemaVersion, 2);
      assert.equal(
        (
          await command('apps/server/src/cli.ts', currentCopy, [
            'restore',
            '--archive',
            currentArchive,
          ])
        ).schemaVersion,
        2,
      );
      await writeFile(
        join(artifacts.evidence, 'guide-archive-result.json'),
        JSON.stringify({
          baselineRevision,
          baselineHash,
          sourceHistory: manifest.database.history,
          restore: result,
          identityPreserved: true,
          fileBytesPreserved: true,
          commandPreserved: true,
        }) + '\n',
      );
    } finally {
      for (const owner of [destination, producer, artifacts]) {
        console.log(
          JSON.stringify({
            event: 'guide.archive.owner-ledger',
            path: owner.evidence + '/owned-resources.json',
          }),
        );
        await owner.cleanup();
      }
    }
  },
);
