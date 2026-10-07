import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { ServerProcess, until } from '../support/server-process.ts';
import { DirectoryLease } from '../../packages/server/src/platform/db/lease.ts';

test(
  'an owned listen collision preserves its original cause, closes service owners and permits a normal retry',
  { timeout: 20000 },
  async () => {
    const target = await new ServerProcess().create(),
      blocker = createServer();
    target.env = { APP_ORIGIN: target.url, RATE_LIMIT_ENABLED: 'false' };
    try {
      await target.startInProcess(
        'owned HTTP port collision',
        async () => {
          await new Promise<void>((resolve) =>
            blocker.listen(target.port, '127.0.0.1', resolve),
          );
        },
        async () => {
          if (blocker.listening)
            await new Promise<void>((resolve) =>
              blocker.close(() => resolve()),
            );
        },
      );
      await target.spawn();
      await until(
        async () => target.child!.exitCode,
        (code) => code !== null,
        10000,
      );
      assert.equal(target.child!.exitCode, 1);
      assert.match(
        target.logs,
        /EADDRINUSE/,
        'original HTTP listen cause remains observable',
      );
      const lease = await DirectoryLease.acquire(target.directory);
      await lease.release();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await target.stop();
      await target.start();
      assert.equal((await fetch(target.url + '/health/ready')).status, 200);
    } finally {
      await target.cleanup();
    }
  },
);
