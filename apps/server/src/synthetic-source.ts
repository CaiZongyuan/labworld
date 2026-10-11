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
  rm,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  SourceStart,
  OwnedSource,
} from '../../../packages/server/src/lab/sessions/service.ts';
import type { Session } from '../../../packages/server/src/lab/sessions/dto.ts';
type Identity = { pid: number; start: string; executable: string };
type Ledger = {
  owner: 'lab-word-synthetic-session-v1';
  session_id: string;
  creator: Identity;
  process?: Identity;
  state: 'launching' | 'owned' | 'cleaned';
  port: number;
  consumers: string[];
  source_kind?: 'newton';
  cache_directory?: string;
  evidence_file?: string;
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
  newton?: { python: string; publisher: string; sceneDirectory: string };
};
export class SyntheticSources {
  readonly options: SourceOptions;
  readonly exited: (id: string) => void;
  readonly log: (entry: Record<string, unknown>) => void;
  private directory: string;
  private creator?: Identity;
  private children = new Set<OwnedSource>();
  private prepared = new Map<
    string,
    { child: ChildProcess; owned: OwnedSource }
  >();
  private newtonSlot?: string;
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
      if (ledger.cache_directory) {
        if (
          ledger.cache_directory !==
          join(
            this.options.directory,
            'runtime',
            'newton-sources',
            ledger.session_id,
          )
        )
          throw new Error('Newton cache ownership mismatch');
        try {
          const marker = JSON.parse(
            await readFile(
              join(ledger.cache_directory, '.source-owner.json'),
              'utf8',
            ),
          ) as { session_id: string; creator: Identity };
          if (
            marker.session_id !== ledger.session_id ||
            !same(marker.creator, ledger.creator)
          )
            throw new Error('Newton cache creator mismatch');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          try {
            await readdir(ledger.cache_directory);
            throw new Error('Newton cache has no ownership receipt');
          } catch (missing) {
            if ((missing as NodeJS.ErrnoException).code !== 'ENOENT')
              throw missing;
          }
        }
        await rm(ledger.cache_directory, { recursive: true, force: true });
      }
      await save(path, ledger);
      this.log({
        event: 'sessions.source_reconciled',
        session_id: ledger.session_id,
        ledger: path,
      });
    }
  }
  async prepare(
    session: Session,
    adopt?: (source: OwnedSource) => void,
  ): Promise<OwnedSource> {
    if (this.newtonSlot) throw new Error('Managed Newton GPU is occupied');
    this.newtonSlot = session.id;
    try {
      return await this.launch(
        { session, ticket: '', websocket_path: '' },
        true,
        adopt,
      );
    } catch (error) {
      if (this.newtonSlot === session.id) this.newtonSlot = undefined;
      throw error;
    }
  }
  private startup(input: SourceStart) {
    const snapshot = input.session.snapshot;
    return {
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
      ...(snapshot.physics ? { physics: snapshot.physics } : {}),
      ...(input.recording ? { recording: input.recording } : {}),
    };
  }
  async launch(
    input: SourceStart,
    preparing = false,
    adopt?: (source: OwnedSource) => void,
  ): Promise<OwnedSource> {
    if (this.stopped || !this.creator)
      throw new Error('Synthetic source owner stopped');
    const existing = this.prepared.get(input.session.id);
    if (existing && !preparing) {
      this.prepared.delete(input.session.id);
      existing.child.stdin!.write(JSON.stringify(this.startup(input)) + '\n');
      return existing.owned;
    }
    const newton = !!input.session.snapshot.physics;
    if (newton && (!preparing || !this.options.newton))
      throw new Error('Newton source requires owned prelease preparation');
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
        ...(newton
          ? {
              source_kind: 'newton' as const,
              cache_directory: join(
                this.options.directory,
                'runtime',
                'newton-sources',
                input.session.id,
              ),
              ...(process.env.LAB_WORD_NEWTON_EVIDENCE_DIRECTORY
                ? {
                    evidence_file: join(
                      resolve(process.env.LAB_WORD_NEWTON_EVIDENCE_DIRECTORY),
                      input.session.id + '.jsonl',
                    ),
                  }
                : {}),
            }
          : {}),
      };
    let child: ChildProcess | undefined,
      closed = false,
      cacheCreated = false,
      cancelled = false,
      stopping: Promise<void> | undefined;
    let finishPreparation!: () => void;
    const preparationDrained = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let finishAdmission!: () => void;
    const admissionDrained = new Promise<void>((resolve) => {
      finishAdmission = resolve;
    });
    const stop = async () => {
      cancelled = true;
      this.prepared.delete(input.session.id);
      if (stopping) return stopping;
      stopping = (async () => {
        // Pending save/cache IO still owns an intent. Drain it before cleanup
        // so it cannot create a new child or directory after stop resolves.
        await preparationDrained;
        if (child && !closed) {
          const exited = once(child, 'close');
          child.stdin?.end();
          child.kill('SIGTERM');
          const timeout = setTimeout(() => {
            if (!closed) child?.kill('SIGKILL');
          }, 2000);
          try {
            await exited;
          } finally {
            clearTimeout(timeout);
          }
        }
        await admissionDrained;
        ledger.state = 'cleaned';
        this.prepared.delete(input.session.id);
        if (this.newtonSlot === input.session.id) this.newtonSlot = undefined;
        if (ledger.cache_directory && cacheCreated)
          await rm(ledger.cache_directory, { recursive: true, force: true });
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
      if (preparing) adopt?.(owned);
      await save(path, ledger);
      if (cancelled || this.stopped)
        throw new Error('Synthetic source launch cancelled');
      if (ledger.cache_directory) {
        await mkdir(join(this.options.directory, 'runtime', 'newton-sources'), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(ledger.cache_directory, { mode: 0o700 });
        cacheCreated = true;
        await writeFile(
          join(ledger.cache_directory, '.source-owner.json'),
          JSON.stringify({
            session_id: input.session.id,
            creator: this.creator,
          }) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
        for (const name of ['tmp', 'xdg', 'cuda', 'torch', 'numba'])
          await mkdir(join(ledger.cache_directory, name), { mode: 0o700 });
        await mkdir(
          join(this.options.directory, 'runtime', 'newton-kernel-cache'),
          { recursive: true, mode: 0o700 },
        );
        if (ledger.evidence_file)
          await mkdir(
            resolve(process.env.LAB_WORD_NEWTON_EVIDENCE_DIRECTORY!),
            { recursive: true, mode: 0o700 },
          );
      }
      if (cancelled || this.stopped)
        throw new Error('Synthetic source launch cancelled');
      child = spawn(
        newton ? this.options.newton!.python : this.options.python,
        [
          newton ? this.options.newton!.publisher : this.options.publisher,
          preparing ? '--prepare-stdin' : '--startup-stdin',
        ],
        {
          stdio: ['pipe', preparing ? 'pipe' : 'ignore', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            LAB_WORD_SYNTHETIC_PARENT_PID: String(process.pid),
            ...(ledger.cache_directory
              ? {
                  PYTHONDONTWRITEBYTECODE: '1',
                  LAB_WORD_NEWTON_SCENE_DIRECTORY:
                    this.options.newton!.sceneDirectory,
                  WARP_CACHE_PATH: join(
                    this.options.directory,
                    'runtime',
                    'newton-kernel-cache',
                  ),
                  CUDA_CACHE_PATH: join(ledger.cache_directory, 'cuda'),
                  XDG_CACHE_HOME: join(ledger.cache_directory, 'xdg'),
                  TMPDIR: join(ledger.cache_directory, 'tmp'),
                  TORCH_HOME: join(ledger.cache_directory, 'torch'),
                  NUMBA_CACHE_DIR: join(ledger.cache_directory, 'numba'),
                }
              : {}),
          },
        },
      );
      finishPreparation();
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
      if (cancelled || this.stopped)
        throw new Error('Synthetic source launch cancelled');
      ledger.state = 'owned';
      await save(path, ledger);
      if (cancelled || this.stopped)
        throw new Error('Synthetic source launch cancelled');
      finishAdmission();
      const snapshot = input.session.snapshot;
      if (preparing) {
        const actual = child;
        const ready = new Promise<void>((resolve, reject) => {
          let buffer = '';
          const timer = setTimeout(
            () => finish(new Error('Newton preparation timed out')),
            120000,
          );
          const finish = (error?: Error) => {
            clearTimeout(timer);
            actual.stdout?.off('data', onData);
            actual.off('close', onClose);
            if (error) reject(error);
            else resolve();
          };
          const onClose = () =>
            finish(new Error('Newton preparation process exited'));
          const onData = (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            if (buffer.length > 16384)
              return finish(new Error('Newton readiness exceeds budget'));
            if (!buffer.includes('\n')) return;
            try {
              const result = JSON.parse(buffer.split('\n')[0]);
              if (
                result.type !== 'newton.prepared' ||
                result.profile_sha256 !== snapshot.physics!.profile_sha256 ||
                result.initial?.sim_time_ns !== 0
              )
                throw new Error('Newton readiness mismatch');
              if (
                !Array.isArray(result.initial.poses) ||
                result.initial.poses.length !== snapshot.initial_poses.length ||
                !Array.isArray(result.initial.joints) ||
                result.initial.joints.length !== snapshot.initial_joints.length
              )
                throw new Error('Newton readiness count mismatch');
              for (const [index, pose] of snapshot.initial_poses.entries())
                for (const field of ['position', 'quaternion'] as const)
                  if (
                    pose[field].some(
                      (value, axis) =>
                        !Number.isFinite(
                          result.initial.poses[index]?.[field]?.[axis],
                        ) ||
                        Math.abs(
                          value - result.initial.poses[index]?.[field]?.[axis],
                        ) > Math.max(0.00001, Math.abs(value) * 0.000001),
                    )
                  )
                    throw new Error('Newton initial FK mismatch');
              if (
                snapshot.initial_joints.some(
                  (value, index) =>
                    !Number.isFinite(result.initial.joints[index]) ||
                    Math.abs(value - result.initial.joints[index]) > 0.00001,
                )
              )
                throw new Error('Newton initial joints mismatch');
              finish();
            } catch {
              finish(new Error('Newton readiness rejected'));
            }
          };
          actual.stdout!.on('data', onData);
          actual.once('close', onClose);
        });
        child.stdin!.write(JSON.stringify(this.startup(input)) + '\n');
        await ready;
        if (cancelled || this.stopped || closed)
          throw new Error('Newton preparation cancelled');
        child.stdout?.resume();
        this.prepared.set(input.session.id, { child, owned });
        return owned;
      }
      child.stdin!.write(JSON.stringify(this.startup(input)) + '\n');
      this.log({
        event: 'sessions.source_owned',
        session_id: input.session.id,
        ledger: path,
        pid: ledger.process.pid,
      });
      return owned;
    } catch (error) {
      finishPreparation();
      finishAdmission();
      try {
        await stop();
      } catch (cleanupError) {
        try {
          this.log({
            event: 'sessions.source_cleanup_failed',
            session_id: input.session.id,
            error: String(cleanupError),
          });
        } catch {
          // Preserve the original launch failure even if cleanup logging fails.
        }
      }
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
