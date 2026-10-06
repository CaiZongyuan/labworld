import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { on, once } from 'node:events';
import { readFile, writeFile, access, stat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ServerProcess } from '../support/server-process.ts';
import {
  recoverServerResources,
  processIdentity,
} from '../support/server-resources.ts';
type Orphan = { ledger: string; childPid: number; directory: string };
async function killCreator(creator: ChildProcess) {
  if (creator.exitCode !== null || creator.signalCode !== null) return;
  const exited = once(creator, 'exit');
  creator.kill('SIGKILL');
  await exited;
}
function assertFaultDirectory(
  actual: { dev: number; ino: number },
  identity: { dev: number; ino: number } | undefined,
  canonical: string,
  owned: { directory: string; ledger: string },
) {
  if (
    !identity ||
    actual.dev !== identity.dev ||
    actual.ino !== identity.ino ||
    canonical !== owned.directory
  )
    throw new Error(
      `Owned fault directory identity changed; retained ${owned.ledger}`,
    );
}
function assertFaultMarker(
  current: string,
  original: string | undefined,
  ledger: string,
) {
  if (current !== original)
    throw new Error(`Unknown fault directory owner marker; retained ${ledger}`);
}
async function withOwnedOrphan<T>(
  context: TestContext,
  action: (
    owned: Orphan,
    mutateMarker: (text: string) => Promise<void>,
  ) => Promise<T>,
) {
  const creator = spawn(
    process.execPath,
    ['--experimental-strip-types', 'tests/support/harness-creator.ts'],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let allocated: { ledger: string; directory: string } | undefined;
  let original: string | undefined;
  let ownMutation: string | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    let owned: Orphan | undefined;
    for await (const [message] of on(creator, 'message', {
      signal: context.signal,
    })) {
      const next = message as Orphan & { stage: string };
      if (next.stage === 'allocated') {
        allocated = next;
        original = await readFile(
          join(next.directory, '.m1-owner.json'),
          'utf8',
        );
        const info = await stat(next.directory);
        identity = { dev: info.dev, ino: info.ino };
      }
      if (next.stage === 'pre-proof') {
        owned = next;
        break;
      }
    }
    assert.ok(owned);
    assert.ok(allocated);
    assert.ok(
      await processIdentity(owned.childPid),
      'The real pre-lease fault child must be alive',
    );
    await killCreator(creator);
    return await action(owned, async (text) => {
      ownMutation = text;
      await writeFile(join(owned.directory, '.m1-owner.json'), text);
    });
  } finally {
    await killCreator(creator);
    if (allocated) {
      const ledger = JSON.parse(await readFile(allocated.ledger, 'utf8')) as {
        state: string;
      };
      if (ledger.state !== 'cleaned') {
        const actual = await stat(allocated.directory);
        assertFaultDirectory(
          actual,
          identity,
          await realpath(allocated.directory),
          allocated,
        );
        const marker = join(allocated.directory, '.m1-owner.json');
        const current = await readFile(marker, 'utf8');
        if (ownMutation && current === ownMutation) {
          assert.ok(original);
          await writeFile(marker, original);
        } else assertFaultMarker(current, original, allocated.ledger);
        await recoverServerResources(allocated.ledger);
      }
    }
  }
}

test(
  'a dead creator is safely recovered at the spawned-child-before-proof/before-lease boundary',
  { timeout: 60000 },
  async (context) => {
    await withOwnedOrphan(context, async (owned, mutate) => {
      await mutate(JSON.stringify({ runId: `tampered-${owned.childPid}` }));
      await assert.rejects(
        recoverServerResources(owned.ledger),
        /owner marker/,
      );
      assert.ok(await processIdentity(owned.childPid));
      await access(owned.directory);
      // finally restores only this fixture's exact mutation and reconciles the orphan.
    });
  },
);

test(
  'a controlled assertion failure after creator death still reconciles the detached orphan',
  { timeout: 60000 },
  async (context) => {
    let saved: Orphan | undefined;
    await assert.rejects(
      withOwnedOrphan(context, async (owned, mutate) => {
        saved = owned;
        await mutate(
          JSON.stringify({ runId: `controlled-failure-${owned.childPid}` }),
        );
        assert.fail('controlled assertion after creator death');
      }),
      /controlled assertion/,
    );
    assert.ok(saved);
    assert.equal(await processIdentity(saved.childPid), undefined);
    await assert.rejects(access(saved.directory));
    assert.equal(
      JSON.parse(await readFile(saved.ledger, 'utf8')).state,
      'cleaned',
    );
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
      await second.stop();
      second.directory = secondDirectory;
      await second.cleanup();
      await first.cleanup();
    }
  },
);
