import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import {
  readFile,
  readlink,
  mkdir,
  readdir,
  writeFile,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SourceStart,
  OwnedSource,
} from '../../../packages/server/src/lab/sessions/service.ts';
type Identity = { pid: number; start: string; executable: string };
type Ledger = {
  owner: 'lab-word-synthetic-session-v1';
  session_id: string;
  creator: Identity;
  process?: Identity;
  state: 'launching' | 'owned' | 'cleaned';
  port: number;
  consumers: string[];
};
const execute = promisify(execFile);
async function identity(pid: number): Promise<Identity | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error('Invalid process identity');
  if (process.platform === 'linux')
    try {
      const stat = (await readFile(`/proc/${pid}/stat`, 'utf8'))
        .split(') ')[1]
        .split(' ');
      if (stat[0] === 'Z') return;
      return {
        pid,
        start: stat[19],
        executable: await readlink(`/proc/${pid}/exe`),
      };
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!))
        return;
      throw error;
    }
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($p){ @{pid=[int]$p.ProcessId;start=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath} | ConvertTo-Json -Compress }`;
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000, windowsHide: true },
    );
    return stdout.trim() ? (JSON.parse(stdout) as Identity) : undefined;
  }
  throw new Error('Synthetic source supervision supports Linux and Windows');
}
function same(a: Identity, b: Identity) {
  return (
    a.pid === b.pid && a.start === b.start && a.executable === b.executable
  );
}
async function save(path: string, ledger: Ledger) {
  await writeFile(path + '.next', JSON.stringify(ledger) + '\n', {
    mode: 0o600,
  });
  await rename(path + '.next', path);
}
async function killOwned(expected: Identity, signal: NodeJS.Signals) {
  const current = await identity(expected.pid);
  if (current && same(current, expected))
    try {
      process.kill(expected.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
}
type SourceOptions = {
  directory: string;
  python: string;
  publisher: string;
  url: string;
  port: number;
};
export class SyntheticSources {
  readonly options: SourceOptions;
  readonly exited: (id: string) => void;
  readonly log: (entry: Record<string, unknown>) => void;
  private directory: string;
  private creator?: Identity;
  private children = new Set<OwnedSource>();
  private stopped = false;
  constructor(
    options: SourceOptions,
    exited: (id: string) => void,
    log: (entry: Record<string, unknown>) => void,
  ) {
    this.options = options;
    this.exited = exited;
    this.log = log;
    this.directory = join(options.directory, 'runtime', 'synthetic-sources');
  }
  async initialize(enabled = true) {
    let names: string[];
    if (enabled) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.creator = await identity(process.pid);
      if (!this.creator) throw new Error('Source owner identity unavailable');
      names = await readdir(this.directory);
    } else {
      try {
        names = await readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const path = join(this.directory, name),
        ledger = JSON.parse(await readFile(path, 'utf8')) as Ledger;
      if (
        ledger.owner !== 'lab-word-synthetic-session-v1' ||
        name !== ledger.session_id + '.json'
      )
        throw new Error('Synthetic source ledger ownership mismatch');
      if (ledger.state === 'cleaned') continue;
      const creator = await identity(ledger.creator.pid);
      if (creator && same(creator, ledger.creator))
        throw new Error('Previous synthetic source owner is still active');
      if (ledger.process) {
        await killOwned(ledger.process, 'SIGTERM');
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
          const actual = await identity(ledger.process.pid);
          if (!actual || !same(actual, ledger.process)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await killOwned(ledger.process, 'SIGKILL');
        const finalDeadline = performance.now() + 2000;
        while (true) {
          const actual = await identity(ledger.process.pid);
          if (!actual || !same(actual, ledger.process)) break;
          if (performance.now() > finalDeadline)
            throw new Error(
              'Owned synthetic source did not stop; ledger retained',
            );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      ledger.state = 'cleaned';
      await save(path, ledger);
      this.log({
        event: 'sessions.source_reconciled',
        session_id: ledger.session_id,
        ledger: path,
      });
    }
  }
  async launch(input: SourceStart): Promise<OwnedSource> {
    if (this.stopped || !this.creator)
      throw new Error('Synthetic source owner stopped');
    const path = join(this.directory, input.session.id + '.json'),
      ledger: Ledger = {
        owner: 'lab-word-synthetic-session-v1',
        session_id: input.session.id,
        creator: this.creator,
        state: 'launching',
        port: this.options.port,
        consumers: [
          `Session ${input.session.id} Publisher`,
          'same-port Motion WebSocket',
          ...(input.recording ? ['same-port Recording WebSocket'] : []),
        ],
      };
    await save(path, ledger);
    let child: ChildProcess | undefined,
      closed = false,
      stopping: Promise<void> | undefined;
    const stop = async () => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (child && !closed) {
          child.stdin?.end();
          child.kill('SIGTERM');
          const timeout = setTimeout(() => {
            if (!closed) child?.kill('SIGKILL');
          }, 2000);
          try {
            await once(child, 'close');
          } finally {
            clearTimeout(timeout);
          }
        }
        ledger.state = 'cleaned';
        await save(path, ledger);
        this.children.delete(owned);
        this.log({
          event: 'sessions.source_cleaned',
          session_id: input.session.id,
          ledger: path,
        });
      })();
      return stopping;
    };
    const owned = { stop };
    this.children.add(owned);
    try {
      child = spawn(
        this.options.python,
        [this.options.publisher, '--startup-stdin'],
        {
          stdio: ['pipe', 'ignore', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            LAB_WORD_SYNTHETIC_PARENT_PID: String(process.pid),
          },
        },
      );
      child.once('close', () => {
        closed = true;
        this.exited(input.session.id);
      });
      child.on('error', () => {});
      child.stdin!.on('error', () => {});
      child.stderr?.resume();
      await once(child, 'spawn');
      ledger.process = await identity(child.pid!);
      if (!ledger.process)
        throw new Error('Synthetic source exited before ownership admission');
      ledger.state = 'owned';
      await save(path, ledger);
      if (this.stopped) throw new Error('Synthetic source launch cancelled');
      const snapshot = input.session.snapshot;
      child.stdin!.write(
        JSON.stringify({
          version: 1,
          url: this.options.url.replace(/^http/, 'ws') + input.websocket_path,
          ticket: input.ticket,
          session_id: input.session.id,
          scene_hash: snapshot.installation.scene_hash,
          body_order: snapshot.installation.pose_keys,
          joint_order: snapshot.installation.joint_keys,
          initial_poses: snapshot.initial_poses,
          initial_joints: snapshot.initial_joints,
          parameters: snapshot.parameters,
          ...(input.recording ? { recording: input.recording } : {}),
        }) + '\n',
      );
      this.log({
        event: 'sessions.source_owned',
        session_id: input.session.id,
        ledger: path,
        pid: ledger.process.pid,
      });
      return owned;
    } catch (error) {
      await stop();
      throw error;
    }
  }
  async stop() {
    this.stopped = true;
    const results = await Promise.allSettled(
      [...this.children].map((child) => child.stop()),
    );
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, 'Owned synthetic source cleanup failed');
  }
}
