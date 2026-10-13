import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { processIdentity } from '../support/server-resources.ts';

const python = process.platform === 'win32' ? 'python' : 'python3';
const available = spawnSync(python, ['--version']).status === 0;
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    await ended;
  } finally {
    clearTimeout(timeout);
  }
}

test(
  'the normal Python source entrypoint reports presence without sampling a GPU and releases only its connection',
  { skip: !available },
  async () => {
    const target = await new ServerProcess().create();
    target.env.APP_ORIGIN = target.url;
    let child: ChildProcess | undefined;
    let logs = '';
    try {
      await target.start();
      const member = new CoreHttp(target.url);
      await member.register('python-source@example.test');
      const lab = await member.json<{ id: string }>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Python presence' },
        201,
      );
      const base = `/api/v1/lab/labs/${lab.id}/sources`;
      const source = await member.json<{ id: string }>(
        'POST',
        base,
        { name: 'Independent entrypoint' },
        201,
      );
      const path = `${base}/${source.id}`;
      const config = await member.json<{ credential: string }>(
        'POST',
        path + '/configuration',
        {},
        201,
      );
      const file = join(target.directory, 'source-config.json');
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
      await target.startInProcess(
        'owned-python-presence-process',
        async () => {
          child = spawn(
            python,
            [
              '-B',
              'tools/source-client/presence.py',
              '--config',
              file,
              '--phase',
              'ready',
              '--duration',
              '2',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          child.stdout!.on('data', (bytes) => {
            logs += String(bytes);
          });

          child.stderr!.on('data', (bytes) => {
            logs += String(bytes);
          });
          await once(child, 'spawn');
          await writeFile(
            join(target.evidence, 'source-client-resources.json'),
            JSON.stringify({
              owner: 'issue-87 normal source client test',
              process: await processIdentity(child.pid!),
              config_file: file,
              credential_in_ledger: false,
              native_program_owned: false,
            }),
          );
        },
        () => stop(child),
      );
      const connected = await until(
        () =>
          member.json<{ connection_state: string; phase: string }>('GET', path),
        (state) => state.connection_state === 'connected',
        7000,
      );
      assert.equal(connected.phase, 'ready');
      await until(
        async () => child!.exitCode,
        (code) => code !== null,
      );
      assert.equal(child!.exitCode, 0, logs);
      assert.equal(
        (await member.json<{ connection_state: string }>('GET', path))
          .connection_state,
        'offline',
      );
      assert.equal(logs.includes(config.credential), false);
      assert.match(logs, /"state": "connected"/);
    } finally {
      await stop(child);
      await target.cleanup();
      await writeFile(
        join(target.evidence, 'source-client-resources.json'),
        JSON.stringify({
          owner: 'issue-87 normal source client test',
          state: 'cleaned',
          child_stopped:
            !child || child.exitCode !== null || child.signalCode !== null,
          native_program_owned: false,
        }),
      );
    }
  },
);

test(
  'HTTP source refusal remains in the independent presence client while its native caller keeps advancing',
  { skip: !available },
  async () => {
    const target = await new ServerProcess().create();
    target.env.APP_ORIGIN = target.url;
    let child: ChildProcess | undefined;
    let logs = '';
    try {
      await target.start();
      const member = new CoreHttp(target.url);
      await member.register('source-refusal@example.test');
      const lab = await member.json<{ id: string }>(
        'POST',
        '/api/v1/lab/labs',
        { name: 'Refusal leaves caller alive' },
        201,
      );
      const base = `/api/v1/lab/labs/${lab.id}/sources`;
      const source = await member.json<{ id: string }>(
        'POST',
        base,
        { name: 'Caller owned' },
        201,
      );
      const config = await member.json<{ credential: string }>(
        'POST',
        `${base}/${source.id}/configuration`,
        {},
        201,
      );
      const file = join(target.directory, 'invalid-source-config.json');
      await writeFile(
        file,
        JSON.stringify({ ...config, credential: 'A'.repeat(43) }),
        { mode: 0o600 },
      );
      const program = `import json,sys,time\nsys.path.insert(0,'tools/source-client')\nfrom presence import start_presence\nclient=start_presence(sys.argv[1])\nsteps=0\ndeadline=time.monotonic()+2\nwhile time.monotonic()<deadline:\n    steps+=1\n    time.sleep(.005)\nstate=client.status\nclient.close()\nsteps+=1\nprint(json.dumps({'steps':steps,'presence':state}))\n`;
      await target.startInProcess(
        'owned-caller-presence-process',
        async () => {
          child = spawn(python, ['-B', '-c', program, file], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          child.stdout!.on('data', (bytes) => {
            logs += String(bytes);
          });
          child.stderr!.on('data', (bytes) => {
            logs += String(bytes);
          });
          await once(child, 'spawn');
          await writeFile(
            join(target.evidence, 'source-client-resources.json'),
            JSON.stringify({
              owner: 'issue-87 source rejection test',
              process: await processIdentity(child.pid!),
              credential_in_ledger: false,
            }),
          );
        },
        () => stop(child),
      );
      await until(
        async () => child!.exitCode,
        (code) => code !== null,
      );
      assert.equal(child!.exitCode, 0, logs);
      const result = JSON.parse(logs);
      assert.equal(result.presence.state, 'authorization_failed');
      assert(result.steps > 100, 'The caller continued after HTTP rejection');
      assert.equal(logs.includes(config.credential), false);
      assert.equal(
        (
          await member.json<{ connection_state: string }>(
            'GET',
            `${base}/${source.id}`,
          )
        ).connection_state,
        'offline',
      );
    } finally {
      await stop(child);
      await target.cleanup();
      await writeFile(
        join(target.evidence, 'source-client-resources.json'),
        JSON.stringify({
          owner: 'issue-87 source rejection test',
          state: 'cleaned',
          child_stopped:
            !child || child.exitCode !== null || child.signalCode !== null,
        }),
      );
    }
  },
);
