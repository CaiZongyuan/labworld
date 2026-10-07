import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';

async function invoke(actor: ServerProcess, args: string[], exit: number) {
  actor.args = args;
  await actor.spawn();
  await until(
    async () => actor.child!.exitCode,
    (value) => value !== null,
    60000,
  );
  assert.equal(actor.child!.exitCode, exit, actor.logs);
  await actor.stop();
}

test(
  'internal.archive-publication: failure preserves a new or empty target and a normal restore recovers',
  { timeout: 90000 },
  async (t) => {
    const source = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create(),
      archive = join(artifacts.directory, 'archive'),
      backup = await new ServerProcess().create();
    try {
      source.env = {
        APP_ORIGIN: source.url,
        FILE_PUBLIC_ORIGIN: source.url,
        RATE_LIMIT_ENABLED: 'false',
      };
      await source.start();
      const reader = new CoreHttp(source.url);
      await reader.register('archive-publish@example.test');
      await publishAsset(reader, await readFile('tests/fixtures/lab/cube.glb'));
      await source.stop();
      backup.entry = 'apps/server/src/cli.ts';
      backup.env = { LAB_WORD_DATA_DIR: source.directory };
      await invoke(backup, ['backup', '--output', archive], 0);
      for (const existing of [false, true])
        await t.test(
          existing ? 'empty destination' : 'new destination',
          async () => {
            const actor = await new ServerProcess().create(),
              restored = await new ServerProcess().create(),
              destination = join(
                artifacts.directory,
                existing ? 'empty' : 'new',
              ),
              report = join(
                artifacts.directory,
                existing ? 'empty.json' : 'new.json',
              );
            try {
              if (existing) await mkdir(destination, { mode: 0o700 });
              actor.entry = 'tests/support/archive-publication-fault.ts';
              actor.env = {
                LAB_WORD_DATA_DIR: destination,
                ARCHIVE_FAULT_DESTINATION: destination,
                ARCHIVE_FAULT_REPORT: report,
              };
              await invoke(actor, ['restore', '--archive', archive], 1);
              assert.match(actor.logs, /Injected archive publication failure/);
              assert.equal(
                JSON.parse(await readFile(report, 'utf8')).refused,
                true,
              );
              if (existing) assert.deepEqual(await readdir(destination), []);
              else await assert.rejects(lstat(destination), { code: 'ENOENT' });
              assert.equal(
                (await readdir(artifacts.directory)).some((name) =>
                  name.startsWith('.lab-word-restore-'),
                ),
                false,
                'owned staging is removed after failure',
              );
              actor.entry = 'apps/server/src/cli.ts';
              await invoke(actor, ['restore', '--archive', archive], 0);
              restored.env = {
                LAB_WORD_DATA_DIR: destination,
                APP_ORIGIN: restored.url,
                RATE_LIMIT_ENABLED: 'false',
              };
              await restored.start();
              await new CoreHttp(restored.url).login(
                'archive-publish@example.test',
              );
            } finally {
              await restored.cleanup();
              await actor.cleanup();
            }
          },
        );
    } finally {
      await backup.cleanup();
      await source.cleanup();
      await artifacts.cleanup();
    }
  },
);
