import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerProcess, until } from '../support/server-process.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';
test(
  'SIGTERM keeps the real startup filesystem preparation owned until it drains and admits no later server stage',
  { timeout: 20000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'tests/support/file-startup-interruption.ts';
    target.ipc = true;
    const stages: string[] = [];
    try {
      await target.spawn();
      target.child!.on('message', (message) =>
        stages.push((message as { stage: string }).stage),
      );
      await until(
        async () => stages.includes('filesystem-admitted'),
        (yes) => yes,
        10000,
      );
      if (process.platform === 'win32') target.child!.send('owned-stop');
      else target.child!.kill('SIGTERM');
      await until(
        async () => stages.includes('interruption-observed'),
        (yes) => yes,
        3000,
      );
      await assert.rejects(
        until(
          async () => {
            try {
              const lease = await DirectoryLease.acquire(target.directory);
              await lease.release();
              return true;
            } catch (error) {
              assert.equal((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
              return false;
            }
          },
          (yes) => yes,
          1000,
        ),
        /timed out/,
      );
      const exited = once(target.child!, 'exit');
      target.child!.send('continue-preparation');
      await exited;
      assert.equal(target.child!.exitCode, 0);
      assert.equal(stages.includes('filesystem-drained'), true);
      assert.equal(stages.includes('owned-stop'), true);
      assert.equal(target.logs.includes('server.ready'), false);
      const lease = await DirectoryLease.acquire(target.directory);
      try {
        const key = await readFile(
          join(target.directory, 'secrets/file-signing-key'),
        );
        assert.equal(key.length, 32);
        assert.deepEqual(
          (await readdir(join(target.directory, 'secrets'))).sort(),
          ['file-signing-key'],
        );
      } finally {
        await lease.release();
      }
    } finally {
      if (target.child?.connected) target.child.send('continue-preparation');
      await target.cleanup();
    }
  },
);
