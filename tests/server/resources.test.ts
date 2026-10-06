import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ServerProcess } from '../support/server-process.ts';
import {
  recoverServerResources,
  processIdentity,
} from '../support/server-resources.ts';

test(
  'a dead creator is safely recovered at the spawned-child-before-proof/before-lease boundary',
  { timeout: 60000 },
  async () => {
    const creator = spawn(
      process.execPath,
      ['--experimental-strip-types', 'tests/support/harness-creator.ts'],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const [message] = (await once(creator, 'message')) as [
      { ledger: string; childPid: number; directory: string },
    ];
    const exited = once(creator, 'exit');
    creator.kill('SIGKILL');
    await exited;
    const marker = join(message.directory, '.m1-owner.json');
    const original = await readFile(marker, 'utf8');
    await writeFile(marker, JSON.stringify({ runId: 'tampered' }));
    await assert.rejects(
      recoverServerResources(message.ledger),
      /owner marker/,
    );
    assert.ok(await processIdentity(message.childPid));
    await access(message.directory);
    await writeFile(marker, original);
    const recovered = await recoverServerResources(message.ledger);
    assert.equal(recovered.state, 'cleaned');
    assert.equal(await processIdentity(message.childPid), undefined);
    await assert.rejects(access(message.directory));
  },
);

test(
  'normal cleanup preserves a directory opened by another live owner and refuses starting after cleanup',
  { timeout: 60000 },
  async () => {
    const first = await new ServerProcess().create();
    const second = await new ServerProcess().create();
    const secondDirectory = second.directory;
    try {
      await first.start();
      await first.stop();
      second.directory = first.directory;
      await second.start();
      await assert.rejects(first.cleanup(), /EADDRINUSE/);
      assert.equal((await fetch(`${second.url}/health/ready`)).status, 200);
      await assert.rejects(first.spawn(), /admission refused/);
      await second.stop();
      second.directory = secondDirectory;
      await first.cleanup();
    } finally {
      await second.cleanup();
      await first.cleanup();
    }
  },
);
