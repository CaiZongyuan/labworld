import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';

async function invoke(actor: ServerProcess, args: string[], exit = 0) {
  actor.args = args;
  await actor.spawn();
  await until(
    async () => actor.child!.exitCode,
    (code) => code !== null,
    60000,
  );
  assert.equal(actor.child!.exitCode, exit, actor.logs);
  await actor.stop();
}
async function treeState(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name),
      info = await lstat(path);
    result.push([
      name,
      info.mode,
      info.isDirectory()
        ? await treeState(path)
        : createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
    ]);
  }
  return result;
}

test(
  'internal.archive-interruption: owned staging is cleaned on cancellation and recovered after abrupt exit',
  { timeout: 120000 },
  async (t) => {
    const source = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create(),
      normal = await new ServerProcess().create(),
      archive = join(artifacts.directory, 'archive'),
      alias = join(artifacts.directory, 'parent-alias'),
      foreign = join(artifacts.directory, '.lab-word-restore-foreign');
    try {
      source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-interrupt@example.test',
      );
      await source.stop();
      normal.entry = 'apps/server/src/cli.ts';
      normal.env = { LAB_WORD_DATA_DIR: source.directory };
      await invoke(normal, ['backup', '--output', archive]);
      await mkdir(foreign);
      await writeFile(
        join(foreign, 'unowned.txt'),
        'Preserve unknown resources',
      );
      await symlink(
        artifacts.directory,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      for (const operation of ['backup', 'restore'])
        for (const signal of ['SIGTERM', 'SIGKILL'] as const)
          await t.test(
            operation + ' ' + signal,
            {
              skip:
                signal === 'SIGTERM' && process.platform === 'win32'
                  ? 'Windows process termination is abrupt; SIGKILL recovery covers it'
                  : false,
            },
            async () => {
              const actor = await new ServerProcess().create(),
                restored = await new ServerProcess().create(),
                destination = join(
                  artifacts.directory,
                  operation + '-' + signal,
                ),
                report = join(
                  artifacts.directory,
                  operation + '-' + signal + '.json',
                );
              try {
                await mkdir(destination, { mode: 0o700 });
                actor.entry = 'tests/support/archive-interruption-fault.ts';
                actor.env = {
                  LAB_WORD_DATA_DIR:
                    operation === 'backup' ? source.directory : destination,
                  ARCHIVE_FAULT_DESTINATION: destination,
                  ARCHIVE_FAULT_BOUNDARY:
                    signal === 'SIGKILL' ? 'publication' : 'copy',
                  ARCHIVE_FAULT_REPORT: report,
                };
                actor.args =
                  operation === 'backup'
                    ? ['backup', '--output', destination]
                    : ['restore', '--archive', archive];
                await actor.spawn();
                await until(
                  () => readFile(report, 'utf8'),
                  (value) => Boolean(value),
                );
                if (operation === 'restore' && signal === 'SIGKILL') {
                  const contender = await new ServerProcess().create();
                  try {
                    await assert.rejects(lstat(destination), {
                      code: 'ENOENT',
                    });
                    contender.env = {
                      LAB_WORD_DATA_DIR: join(alias, basename(destination)),
                    };
                    await contender.spawn();
                    await until(
                      async () => contender.child!.exitCode,
                      (code) => code !== null,
                    );
                    assert.equal(contender.child!.exitCode, 1, contender.logs);
                    assert.match(contender.logs, /EADDRINUSE/);
                    await assert.rejects(lstat(destination), {
                      code: 'ENOENT',
                    });
                  } finally {
                    await contender.cleanup();
                  }
                }
                actor.child!.kill(signal);
                await until(
                  async () => [actor.child!.exitCode, actor.child!.signalCode],
                  ([exit, stopped]) => exit !== null || stopped !== null,
                );
                if (signal === 'SIGTERM') {
                  assert.equal(actor.child!.exitCode, 143, actor.logs);
                  assert.deepEqual(await readdir(destination), []);
                } else {
                  assert.equal(actor.child!.signalCode, 'SIGKILL');
                  await assert.rejects(lstat(destination), { code: 'ENOENT' });
                  const ledgers = (await readdir(artifacts.directory)).filter(
                    (name) =>
                      name.startsWith('.lab-word-' + operation + '-') &&
                      name.endsWith('.json'),
                  );
                  assert.equal(
                    ledgers.length,
                    1,
                    'abrupt exit retains an owned recovery ledger',
                  );
                }
                await actor.stop();
                actor.entry = 'apps/server/src/cli.ts';
                if (operation === 'restore' && signal === 'SIGKILL') {
                  const name = (await readdir(artifacts.directory)).find(
                      (name) =>
                        name.startsWith('.lab-word-restore-') &&
                        name.endsWith('.json'),
                    )!,
                    marker = join(artifacts.directory, name),
                    before = await readFile(marker, 'utf8'),
                    stage = JSON.parse(before).stage as string;
                  let consumer: DirectoryLease | undefined;
                  await actor.startInProcess(
                    'live interrupted-stage consumer',
                    async () => {
                      consumer = await DirectoryLease.acquire(stage);
                    },
                    async () => {
                      await consumer?.release();
                    },
                  );
                  await actor.spawn();
                  await until(
                    async () => actor.child!.exitCode,
                    (code) => code !== null,
                    60000,
                  );
                  assert.equal(actor.child!.exitCode, 1, actor.logs);
                  assert.match(actor.logs, /EADDRINUSE/);
                  assert.equal(await readFile(marker, 'utf8'), before);
                  assert.equal((await lstat(stage)).isDirectory(), true);
                  await actor.stop();
                  await consumer!.release();
                  consumer = undefined;
                }
                await invoke(actor, actor.args);
                assert.deepEqual(
                  (await readdir(artifacts.directory)).filter(
                    (name) =>
                      name.startsWith('.lab-word-') &&
                      name !== '.lab-word-restore-foreign',
                  ),
                  [],
                  'normal retry reconciles only owned staging and ledgers',
                );
                assert.equal(
                  await readFile(join(foreign, 'unowned.txt'), 'utf8'),
                  'Preserve unknown resources',
                );
                if (operation === 'backup') {
                  actor.env = {
                    LAB_WORD_DATA_DIR: join(
                      artifacts.directory,
                      operation + '-' + signal + '-restored',
                    ),
                  };
                  await invoke(actor, ['restore', '--archive', destination]);
                }
                restored.env = {
                  APP_ORIGIN: restored.url,
                  RATE_LIMIT_ENABLED: 'false',
                  LAB_WORD_DATA_DIR:
                    operation === 'backup'
                      ? actor.env.LAB_WORD_DATA_DIR
                      : destination,
                };
                await restored.start();
                assert.equal(
                  (
                    await new CoreHttp(restored.url).login(
                      'archive-interrupt@example.test',
                    )
                  ).user.id,
                  session.user.id,
                );
                console.log(
                  JSON.stringify({
                    event: 'm4.archive-interruption',
                    operation,
                    signal,
                    actorLedger: join(actor.evidence, 'owned-resources.json'),
                    outcome:
                      signal === 'SIGTERM'
                        ? 'cooperative-cleanup'
                        : 'intentional-abrupt-exit-and-owned-recovery',
                  }),
                );
              } finally {
                await restored.cleanup();
                await actor.cleanup();
              }
            },
          );
      await t.test(
        'published restore SIGKILL preserves the complete target while retry removes only its ledger',
        async () => {
          const actor = await new ServerProcess().create(),
            restored = await new ServerProcess().create(),
            destination = join(artifacts.directory, 'published'),
            report = join(artifacts.directory, 'published.json');
          try {
            actor.entry = 'tests/support/archive-interruption-fault.ts';
            actor.args = ['restore', '--archive', archive];
            actor.env = {
              LAB_WORD_DATA_DIR: destination,
              ARCHIVE_FAULT_DESTINATION: destination,
              ARCHIVE_FAULT_BOUNDARY: 'published',
              ARCHIVE_FAULT_REPORT: report,
            };
            await actor.spawn();
            await until(
              () => readFile(report, 'utf8'),
              (value) => Boolean(value),
            );
            actor.child!.kill('SIGKILL');
            await until(
              async () => actor.child!.signalCode,
              (value) => value !== null,
            );
            assert.equal(actor.child!.signalCode, 'SIGKILL');
            await actor.stop();
            const before = await treeState(destination);
            actor.entry = 'apps/server/src/cli.ts';
            await invoke(actor, actor.args, 1);
            assert.match(actor.logs, /Destination must be new or empty/);
            assert.deepEqual(await treeState(destination), before);
            assert.deepEqual(
              (await readdir(artifacts.directory)).filter(
                (name) =>
                  name.startsWith('.lab-word-') &&
                  name !== '.lab-word-restore-foreign',
              ),
              [],
            );
            restored.env = {
              LAB_WORD_DATA_DIR: destination,
              APP_ORIGIN: restored.url,
              RATE_LIMIT_ENABLED: 'false',
            };
            await restored.start();
            assert.equal(
              (
                await new CoreHttp(restored.url).login(
                  'archive-interrupt@example.test',
                )
              ).user.id,
              session.user.id,
            );
            console.log(
              JSON.stringify({
                event: 'm4.archive-interruption',
                operation: 'restore',
                signal: 'SIGKILL',
                actorLedger: join(actor.evidence, 'owned-resources.json'),
                outcome: 'published-target-preserved',
              }),
            );
          } finally {
            await restored.cleanup();
            await actor.cleanup();
          }
        },
      );
    } finally {
      await normal.cleanup();
      await source.cleanup();
      await artifacts.cleanup();
    }
  },
);
