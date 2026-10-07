import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

async function invoke(actor: ServerProcess, args: string[], exit: number) {
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

test(
  'internal.archive-stage-identity: recovery preserves a replacement directory and retries only after the original stage returns',
  { timeout: 60000 },
  async () => {
    const source = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create(),
      actor = await new ServerProcess().create(),
      restored = await new ServerProcess().create(),
      archive = join(artifacts.directory, 'archive'),
      destination = join(artifacts.directory, 'target'),
      saved = join(artifacts.directory, 'saved-owned-stage'),
      report = join(artifacts.directory, 'staged.json');
    try {
      source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-stage@example.test',
      );
      await source.stop();
      actor.entry = 'apps/server/src/cli.ts';
      actor.env = { LAB_WORD_DATA_DIR: source.directory };
      await invoke(actor, ['backup', '--output', archive], 0);
      await mkdir(destination, { mode: 0o700 });
      const emptyBefore = await lstat(destination);
      actor.entry = 'tests/support/archive-interruption-fault.ts';
      actor.args = ['restore', '--archive', archive];
      actor.env = {
        LAB_WORD_DATA_DIR: destination,
        ARCHIVE_FAULT_DESTINATION: destination,
        ARCHIVE_FAULT_BOUNDARY: 'publication',
        ARCHIVE_FAULT_REPORT: report,
      };
      await actor.spawn();
      await until(
        () => readFile(report, 'utf8'),
        (text) => Boolean(text),
      );
      actor.child!.kill('SIGKILL');
      await until(
        async () => actor.child!.signalCode,
        (code) => code !== null,
      );
      assert.equal(actor.child!.signalCode, 'SIGKILL');
      await actor.stop();
      const name = (await readdir(artifacts.directory)).find(
          (name) =>
            name.startsWith('.lab-word-restore-') && name.endsWith('.json'),
        )!,
        marker = join(artifacts.directory, name),
        before = await readFile(marker, 'utf8'),
        stage = JSON.parse(before).stage as string;
      await rename(stage, saved);
      await mkdir(stage, { mode: 0o700 });
      const sentinel = join(stage, 'retained.txt');
      await writeFile(sentinel, 'Unrelated replacement must remain');
      actor.entry = 'apps/server/src/cli.ts';
      await invoke(actor, actor.args, 1);
      assert.match(actor.logs, /identity|ownership|changed/i);
      assert.equal(await readFile(marker, 'utf8'), before);
      assert.equal(
        await readFile(sentinel, 'utf8'),
        'Unrelated replacement must remain',
      );
      assert.deepEqual(await readdir(stage), ['retained.txt']);
      assert.deepEqual(await readdir(destination), []);
      assert.equal((await lstat(destination)).mode, emptyBefore.mode);
      // The fixture owns this replacement; the operation did not delete it.
      await rm(stage, { recursive: true });
      await rename(saved, stage);
      await invoke(actor, actor.args, 0);
      assert.equal(
        (await readdir(artifacts.directory)).some((name) =>
          name.startsWith('.lab-word-restore-'),
        ),
        false,
      );
      restored.env = {
        LAB_WORD_DATA_DIR: destination,
        APP_ORIGIN: restored.url,
        RATE_LIMIT_ENABLED: 'false',
      };
      await restored.start();
      assert.equal(
        (await new CoreHttp(restored.url).login('archive-stage@example.test'))
          .user.id,
        session.user.id,
      );
      console.log(
        JSON.stringify({
          event: 'm4.archive-stage-identity',
          actorLedger: join(actor.evidence, 'owned-resources.json'),
          replacement: 'preserved',
          original: 'reconciled-and-retried',
        }),
      );
    } finally {
      await restored.cleanup();
      await actor.cleanup();
      await source.cleanup();
      await artifacts.cleanup();
    }
  },
);

test(
  'internal.archive-stage-identity: publication identity refusal preserves the original empty target and the replacement',
  { timeout: 60000 },
  async () => {
    const source = await new ServerProcess().create(),
      artifacts = await new ServerProcess().create(),
      actor = await new ServerProcess().create(),
      restored = await new ServerProcess().create(),
      archive = join(artifacts.directory, 'archive'),
      destination = join(artifacts.directory, 'empty'),
      saved = join(artifacts.directory, 'original-owned-stage'),
      report = join(artifacts.directory, 'publication.json');
    try {
      source.env = { APP_ORIGIN: source.url, RATE_LIMIT_ENABLED: 'false' };
      await source.start();
      const session = await new CoreHttp(source.url).register(
        'archive-empty-stage@example.test',
      );
      await source.stop();
      actor.entry = 'apps/server/src/cli.ts';
      actor.env = { LAB_WORD_DATA_DIR: source.directory };
      await invoke(actor, ['backup', '--output', archive], 0);
      await mkdir(destination, { mode: 0o700 });
      const before = await lstat(destination);
      actor.entry = 'tests/support/archive-stage-publication-replacement.ts';
      actor.env = {
        LAB_WORD_DATA_DIR: destination,
        ARCHIVE_FAULT_DESTINATION: destination,
        ARCHIVE_FAULT_SAVED: saved,
        ARCHIVE_FAULT_REPORT: report,
      };
      await invoke(actor, ['restore', '--archive', archive], 1);
      assert.match(actor.logs, /identity|ownership|changed/i);
      assert.deepEqual(await readdir(destination), []);
      assert.equal((await lstat(destination)).mode, before.mode);
      const fault = JSON.parse(await readFile(report, 'utf8')) as {
        stage: string;
        marker: string;
        ledger: string;
      };
      assert.equal(await readFile(fault.marker, 'utf8'), fault.ledger);
      assert.equal(
        await readFile(join(fault.stage, 'retained.txt'), 'utf8'),
        'Preserve publication replacement',
      );
      assert.deepEqual(await readdir(fault.stage), ['retained.txt']);
      await rm(fault.stage, { recursive: true });
      await rename(saved, fault.stage);
      actor.entry = 'apps/server/src/cli.ts';
      await invoke(actor, actor.args, 0);
      restored.env = {
        LAB_WORD_DATA_DIR: destination,
        APP_ORIGIN: restored.url,
        RATE_LIMIT_ENABLED: 'false',
      };
      await restored.start();
      assert.equal(
        (
          await new CoreHttp(restored.url).login(
            'archive-empty-stage@example.test',
          )
        ).user.id,
        session.user.id,
      );
    } finally {
      await restored.cleanup();
      await actor.cleanup();
      await source.cleanup();
      await artifacts.cleanup();
    }
  },
);
