import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';

test(
  'a real schema-five directory upgrades through Source six to Asset seven without losing identity or GLB bytes',
  { timeout: 90000 },
  async () => {
    const artifacts = await new ServerProcess().create(),
      target = await new ServerProcess().create();
    target.env = {
      APP_ORIGIN: target.url,
      FILE_PUBLIC_ORIGIN: target.url,
      RATE_LIMIT_ENABLED: 'false',
    };
    const baseline = join(artifacts.directory, 'schema-five-source');
    try {
      await mkdir(baseline);
      const archive = execFileSync(
        'git',
        [
          'archive',
          '--format=tar',
          'ebf4e9a28b82f81e9551b5c225afa024907ea46b',
          'apps/server',
          'packages/server',
          'packages/contracts',
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      execFileSync('tar', ['-xf', '-', '-C', baseline], { input: archive });
      for (const path of [
        'node_modules',
        'apps/server/node_modules',
        'packages/server/node_modules',
      ]) {
        await mkdir(join(baseline, path, '..'), { recursive: true });
        await symlink(
          await realpath(resolve(path)),
          join(baseline, path),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      target.entry = join(baseline, 'apps/server/src/main.ts');
      await target.start();
      const member = new CoreHttp(target.url);
      const identity = await member.register('asset-upgrade@example.test');
      assert.equal(
        (
          await member.json<{ schema_version: number }>(
            'GET',
            '/api/v1/system/status',
          )
        ).schema_version,
        5,
      );
      const model = await publishAsset(
        member,
        await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
        'Five-era model',
      );
      await target.stop();

      const sourceSQL = await readFile(
        'packages/server/migrations/0005_source_presence.sql',
      );
      assert.equal(
        createHash('sha256').update(sourceSQL).digest('hex'),
        '443bbf6e2485d219ea4c6a9e528c9a29f1339aecdf47de1a9eeb51bb65d1df80',
      );
      await writeFile(
        join(baseline, 'packages/server/migrations/0005_source_presence.sql'),
        sourceSQL,
      );
      const journalPath = join(
        baseline,
        'packages/server/migrations/meta/_journal.json',
      );
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.entries.push({
        idx: 5,
        version: '7',
        when: 1791936000000,
        tag: '0005_source_presence',
        breakpoints: true,
      });
      await writeFile(journalPath, JSON.stringify(journal));
      await target.start();
      assert.equal(
        (await member.login('asset-upgrade@example.test')).user.id,
        identity.user.id,
      );
      assert.equal(
        (
          await member.json<{ schema_version: number }>(
            'GET',
            '/api/v1/system/status',
          )
        ).schema_version,
        6,
      );
      assert.deepEqual(
        await member.json('GET', `/api/v1/lab/assets/${model.id}`),
        model,
      );
      await target.stop();

      target.entry = 'apps/server/src/main.ts';
      await target.start();
      assert.equal(
        (await member.login('asset-upgrade@example.test')).user.id,
        identity.user.id,
      );
      assert.equal(
        (
          await member.json<{ schema_version: number }>(
            'GET',
            '/api/v1/system/status',
          )
        ).schema_version,
        7,
      );
      assert.deepEqual(
        await member.json('GET', `/api/v1/lab/assets/${model.id}`),
        model,
      );
      const description = {
        schema_version: 1,
        asset_id: 'upgrade/instrument',
        version: '1.0',
        name: 'Upgraded asset',
        category: 'instrument',
        source: 'Fixture',
        license: 'CC0',
        specifications: {},
        configuration_schema: { type: 'object', properties: {} },
        state_schema: { type: 'object', properties: {} },
        capabilities: [],
        resources: [
          {
            key: 'body',
            format: 'glb',
            file_id: model.representation.file_id,
            size: model.representation.size,
            sha256: model.representation.sha256,
          },
        ],
        representations: [
          {
            key: 'web',
            purpose: 'visual',
            resource_keys: ['body'],
            components: [],
          },
        ],
      };
      const version = await member.json<{ id: string }>(
        'POST',
        '/api/v1/lab/asset-versions',
        description,
        201,
      );
      await target.stop();
      await target.start();
      await member.login('asset-upgrade@example.test');
      assert.deepEqual(
        await member.json('GET', `/api/v1/lab/asset-versions/${version.id}`),
        version,
      );
      assert.equal(
        (
          await member.json<{ schema_version: number }>(
            'GET',
            '/api/v1/system/status',
          )
        ).schema_version,
        7,
      );
    } finally {
      for (const owner of [target, artifacts]) {
        console.log(
          JSON.stringify({
            event: 'asset-upgrade.owned-ledger',
            path: owner.evidence + '/owned-resources.json',
          }),
        );
        await owner.cleanup();
      }
    }
  },
);
