import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { beginAsset } from '../support/lab-assets-http.ts';
import type {
  DownloadCapability,
  LabAsset,
} from '../../packages/contracts/src/generated/types.gen.ts';

test(
  'production same-origin hosting serves the built Web app, preserves API failures and transports signed asset bytes',
  { timeout: 120000 },
  async () => {
    const target = await new ServerProcess().create(),
      build = await new ServerProcess().create(),
      directory = join(build.directory, 'web');
    try {
      build.entry = 'node_modules/vite/bin/vite.js';
      build.args = [
        'build',
        'apps/web',
        '--config',
        'apps/web/vite.config.ts',
        '--outDir',
        directory,
      ];
      await build.spawn();
      await until(
        async () => build.child!.exitCode,
        (code) => code !== null,
        60000,
      );
      assert.equal(build.child!.exitCode, 0, build.logs);
      await build.stop();
      build.entry = 'scripts/build-server.mjs';
      build.args = ['--outDir', join(build.directory, 'server')];
      await build.spawn();
      await until(
        async () => build.child!.exitCode,
        (code) => code !== null,
        60000,
      );
      assert.equal(build.child!.exitCode, 0, build.logs);
      await build.stop();
      target.entry = join(build.directory, 'server/apps/server/src/main.js');
      const artifact = join(build.directory, 'server');
      const applicationPackage = createRequire(target.entry).resolve(
        '@hono/node-server',
      );
      const databasePackage = createRequire(
        join(artifact, 'packages/server/src/platform/db/index.js'),
      ).resolve('@electric-sql/pglite');
      assert.equal(applicationPackage.startsWith(artifact + sep), true);
      assert.equal(databasePackage.startsWith(artifact + sep), true);
      console.log(
        JSON.stringify({
          event: 'm6.compiled-dependency-resolution',
          application: relative(artifact, applicationPackage),
          database: relative(artifact, databasePackage),
          runtimeDependencies: JSON.parse(
            await readFile(
              join(artifact, '.lab-word-server-build.json'),
              'utf8',
            ),
          ).runtimeDependencies,
        }),
      );
      const index = await readFile(join(directory, 'index.html'), 'utf8');
      target.env = {
        APP_ORIGIN: target.url,
        FILE_PUBLIC_ORIGIN: target.url,
        RATE_LIMIT_ENABLED: 'false',
        LAB_WORD_WEB_DIR: directory,
      };
      await build.startInProcess(
        'compiled server and static Web consumer',
        async () => {
          await target.start();
        },
        () => target.cleanup(),
      );
      for (const path of [
        '/',
        '/lab?lab=chosen&entity=selected',
        '/api-keys',
        '/settings',
        '/notifications',
      ]) {
        const response = await fetch(target.url + path, {
          headers: { accept: 'text/html' },
        });
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('content-type')!, /text\/html/);
        assert.equal(await response.text(), index);
      }
      const script = index.match(/<script[^>]+src="([^"]+)"/)![1],
        response = await fetch(target.url + script);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /javascript/);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        await readFile(join(directory, script)),
      );
      for (const [path, status] of [
        ['/api/v1/missing', 404],
        ['/api/missing', 404],
        ['/objects/missing', 403],
        ['/health/missing', 404],
        ['/assets/missing.js', 404],
      ] as const) {
        const refusal = await fetch(target.url + path, {
          headers: { accept: 'text/html' },
        });
        assert.equal(refusal.status, status, path);
        assert.match(refusal.headers.get('content-type')!, /application\/json/);
        assert.equal(
          (await refusal.json()).error.request_id,
          refusal.headers.get('x-request-id'),
        );
      }
      const member = new CoreHttp(target.url);
      await member.register('production-web@example.test');
      const bytes = await readFile('tests/fixtures/lab/cube.glb'),
        upload = await beginAsset(member, bytes),
        asset = await member.json<LabAsset>('POST', upload.path),
        download = await member.json<DownloadCapability>(
          'GET',
          '/api/v1/lab/assets/' + asset.id + '/download',
        );
      assert.equal(new URL(upload.upload.upload!.url).origin, target.url);
      assert.equal(new URL(download.url).origin, target.url);
      const delivered = await fetch(download.url);
      assert.equal(delivered.status, 200);
      assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), bytes);
      for (const name of [
        'cube-draco.glb',
        'cube-meshopt.glb',
        'cube-basis.glb',
      ]) {
        const compressed = await readFile('tests/fixtures/lab/' + name),
          attempt = await beginAsset(member, compressed, name),
          published = await member.json<LabAsset>('POST', attempt.path),
          capability = await member.json<DownloadCapability>(
            'GET',
            '/api/v1/lab/assets/' + published.id + '/download',
          ),
          response = await fetch(capability.url);
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
      }
      const corrupted = await readFile('tests/fixtures/lab/cube-meshopt.glb');
      corrupted.fill(0, 28 + corrupted.readUInt32LE(12));
      const rejected = await beginAsset(member, corrupted, 'Broken Meshopt');
      await member.error(
        'POST',
        rejected.path,
        undefined,
        422,
        'files.upload_rejected',
      );
      console.log(
        JSON.stringify({
          event: 'm4.production-web-http',
          buildLedger: join(build.evidence, 'owned-resources.json'),
          serverLedger: join(target.evidence, 'owned-resources.json'),
          sameOriginBytes: bytes.length,
        }),
      );
    } finally {
      await target.cleanup();
      await build.cleanup();
    }
  },
);
