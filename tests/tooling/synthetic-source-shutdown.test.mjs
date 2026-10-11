import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import * as util from 'node:util';
import * as path from 'node:path';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/server/src/synthetic-source.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(block, options = {}) {
  const entered = deferred(),
    release = deferred(),
    files = new Map(),
    directories = new Set();
  let blocked = false,
    spawns = 0,
    adopted;
  const pause = async (kind, target, text) => {
    if (!blocked && block(kind, target, text)) {
      blocked = true;
      entered.resolve();
      await release.promise;
      if (options.preparationError) throw options.preparationError;
    }
  };
  const io = {
    readFile: async (target) =>
      target.startsWith('/proc/')
        ? 'p) S ' + Array(19).fill('0').join(' ') + ' 123'
        : files.get(target),
    readlink: async () => '/mock/python',
    readdir: async () => [],
    mkdir: async (target) => {
      await pause('mkdir', target);
      directories.add(target);
    },
    writeFile: async (target, text) => {
      await pause('write', target, text);
      files.set(target, text);
    },
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    rm: async (target) => {
      if (options.cleanupError) throw options.cleanupError;
      for (const name of directories)
        if (name === target || name.startsWith(target + '/'))
          directories.delete(name);
      for (const name of files.keys())
        if (name.startsWith(target + '/')) files.delete(name);
    },
  };
  const spawn = () => {
    spawns += 1;
    if (options.spawnError) throw options.spawnError;
    const child = new EventEmitter();
    child.pid = 987654;
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.resume = child.stderr.resume = () => {};
    child.stdin.end = () => {};
    child.kill = () => {
      queueMicrotask(() => child.emit('close'));
      return true;
    };
    child.stdin.write = (text) => {
      const input = JSON.parse(text);
      if (!input.physics) return;
      queueMicrotask(() =>
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              type: 'newton.prepared',
              profile_sha256: input.physics.profile_sha256,
              initial: { sim_time_ns: 0, poses: [], joints: [] },
            }) + '\n',
          ),
        ),
      );
    };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const modules = {
    'node:child_process': { spawn, execFile() {} },
    'node:util': util,
    'node:events': {
      once: (awaitable, event) =>
        new Promise((done, reject) => {
          awaitable.once(event, done);
          if (event !== 'close') awaitable.once('error', reject);
        }),
    },
    'node:fs/promises': io,
    'node:path': path,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', compiled)(
    (name) => modules[name],
    module,
    module.exports,
    {
      platform: 'linux',
      pid: process.pid,
      env: {},
      kill() {
        throw new Error('Unexpected process kill');
      },
    },
  );
  const manager = new module.exports.SyntheticSources(
    {
      directory: '/owned',
      python: '/mock/python',
      publisher: '/mock/pub',
      url: 'http://localhost',
      port: 1,
      newton: {
        python: '/mock/python',
        publisher: '/mock/newton',
        sceneDirectory: '/scene',
      },
    },
    () => {},
    () => {},
  );
  const session = {
    id: '11111111-1111-1111-1111-111111111111',
    snapshot: {
      installation: { scene_hash: 's', pose_keys: [], joint_keys: [] },
      physics: { profile_sha256: 'p' },
      initial_poses: [],
      initial_joints: [],
      parameters: {},
    },
  };
  return {
    manager,
    session,
    entered,
    release,
    files,
    directories,
    get spawns() {
      return spawns;
    },
    adopt(value) {
      adopted = value;
    },
    get adopted() {
      return adopted;
    },
  };
}
for (const [name, block] of [
  [
    'first ledger write',
    (kind, target) => kind === 'write' && target.endsWith('.json.next'),
  ],
  [
    'cache preparation mkdir',
    (kind, target) =>
      kind === 'mkdir' && target === '/owned/runtime/newton-sources',
  ],
  [
    'child ownership ledger',
    (kind, target, text) =>
      kind === 'write' &&
      target.endsWith('.json.next') &&
      JSON.parse(text).state === 'owned',
  ],
]) {
  test(
    'stop drains pending ' + name + ' and prevents resources after return',
    async () => {
      const f = fixture(block);
      await f.manager.initialize();
      const launch = f.manager
        .prepare(f.session, (owned) => f.adopt(owned))
        .catch((error) => error);
      await f.entered.promise;
      assert.ok(f.adopted, 'preparation intent is adopted before pending IO');
      let completed = false;
      const stopped = f.manager.stop().then(() => {
        completed = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(completed, false);
      const spawnedBeforeRelease = f.spawns;
      f.release.resolve();
      await stopped;
      assert.match((await launch).message, /cancelled/);
      assert.equal(f.spawns, spawnedBeforeRelease, 'no late spawn');
      assert.equal(
        [...f.directories].some((entry) => entry.includes(f.session.id)),
        false,
      );
      const ledger = JSON.parse(
        f.files.get(
          '/owned/runtime/synthetic-sources/' + f.session.id + '.json',
        ),
      );
      assert.equal(
        ledger.state,
        'cleaned',
        'no late ownership receipt overwrites cleanup',
      );
    },
  );
}
test('preparation Stop drains thrown IO and preserves the first error', async () => {
  const failure = new Error('original IO error');
  const f = fixture(
    (kind, target) =>
      kind === 'mkdir' && target === '/owned/runtime/newton-sources',
    { preparationError: failure },
  );
  await f.manager.initialize();
  const launch = f.manager.prepare(f.session).catch((error) => error);
  await f.entered.promise;
  const stopped = f.manager.stop();
  f.release.resolve();
  await stopped;
  assert.equal(await launch, failure);
  assert.equal(f.spawns, 0);
});
test('spawn failure retains the original exception even when cleanup fails', async () => {
  const failure = new Error('original spawn error');
  const f = fixture(() => false, {
    spawnError: failure,
    cleanupError: new Error('cleanup error'),
  });
  await f.manager.initialize();
  await assert.rejects(
    f.manager.prepare(f.session),
    (error) => error === failure,
  );
  await assert.rejects(f.manager.stop(), AggregateError);
});

test('owned prelease cancellation prevents spawn even while the manager stays open', async () => {
  const f = fixture(() => false);
  await f.manager.initialize();
  let stopped;
  await assert.rejects(
    f.manager.prepare(f.session, (owned) => {
      stopped = owned.stop();
    }),
    /cancelled/,
  );
  await stopped;
  assert.equal(f.spawns, 0);
  await f.manager.stop();
});
test('ordinary Synthetic launch and shutdown retains its public ownership behavior', async () => {
  const f = fixture(() => false);
  await f.manager.initialize();
  const session = {
    ...f.session,
    snapshot: { ...f.session.snapshot, physics: undefined },
  };
  const owned = await f.manager.launch({
    session,
    ticket: 't',
    websocket_path: '/motion',
  });
  assert.equal(f.spawns, 1);
  await owned.stop();
  await f.manager.stop();
});
