import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  realpath,
} from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  processIdentity,
  removeOwnedDirectory,
  type ProcessIdentity,
  type ServerLedger,
  type LaunchIntent,
} from './server-resources.ts';
const owned = new Set<ServerProcess>();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (interrupted) return;
    interrupted = true;
    void Promise.allSettled([...owned].map((target) => target.cleanup())).then(
      (results) => {
        for (const result of results)
          if (result.status === 'rejected')
            console.error(String(result.reason));
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
      },
    );
  });
export async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  let last: unknown;
  do {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error('Server condition timed out', { cause: last });
}
export class ServerProcess {
  directory = '';
  evidence = '';
  port = 0;
  child?: ChildProcess;
  logs = '';
  entry = 'apps/server/src/main.ts';
  env: Record<string, string> = {};
  // Harness fault seam: lets the owned creator proof exercise slow Windows identity lookup.
  beforeIdentity?: () => Promise<void>;
  // This fault fixture must survive Windows' normal kill-on-parent-exit Job.
  detachedChildForRecoveryProof = false;
  private runId = randomUUID();
  private creator?: ProcessIdentity;
  private childProof?: ProcessIdentity;
  private launchIntent?: LaunchIntent;
  private closed = false;
  private cleanupPromise?: Promise<void>;
  private creating?: Promise<void>;
  private spawning?: Promise<void>;
  private assertOpen() {
    if (interrupted || this.closed)
      throw new Error(
        'Harness was cancelled or cleaned; new process admission refused',
      );
  }
  async create() {
    this.assertOpen();
    owned.add(this);
    this.creating = (async () => {
      this.creator = await processIdentity(process.pid);
      if (!this.creator) throw new Error('Creator identity is unavailable');
      this.assertOpen();
      this.directory = await realpath(
        await mkdtemp(join(tmpdir(), 'lab-word-m1-')),
      );
      await writeFile(
        join(this.directory, '.m1-owner.json'),
        JSON.stringify({ runId: this.runId, creator: this.creator }),
      );
      this.evidence = resolve(
        '.scratch/vnext-m1',
        this.directory.split(/[\\/]/).at(-1)!,
      );
      await mkdir(this.evidence, { recursive: true });
      this.port = await availablePort();
      await this.record();
      this.assertOpen();
    })();
    try {
      await this.creating;
      return this;
    } finally {
      this.creating = undefined;
    }
  }
  get url() {
    return `http://127.0.0.1:${this.port}`;
  }
  private ledger(): ServerLedger {
    return {
      owner: 'M1 server process harness',
      runId: this.runId,
      creator: this.creator!,
      directory: this.directory,
      port: this.port,
      processes: this.childProof ? [this.childProof] : [],
      ...(this.launchIntent ? { launchIntent: this.launchIntent } : {}),
      docker: [],
      state: this.directory ? 'owned' : 'cleaned',
    };
  }
  async record() {
    await writeFile(
      join(this.evidence, 'owned-resources.json'),
      JSON.stringify(this.ledger(), null, 2),
    );
  }
  async spawn() {
    this.assertOpen();
    this.spawning = (async () => {
      this.logs = '';
      this.launchIntent = {
        title: `lab-word-m1-${this.runId}`,
        entry: this.entry,
        executable: this.creator!.executable,
        state: 'planned',
      };
      await this.record();
      this.assertOpen();
      this.child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          `--title=${this.launchIntent.title}`,
          this.entry,
        ],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            SERVER_PORT: String(this.port),
            LAB_WORD_DATA_DIR: this.directory,
            ...this.env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: this.detachedChildForRecoveryProof,
        },
      );
      const child = this.child;
      this.launchIntent.pid = child.pid;
      this.launchIntent.state = 'launched';
      writeFileSync(
        join(this.evidence, 'owned-resources.json'),
        JSON.stringify(this.ledger(), null, 2),
      );
      child.stdout!.on('data', (chunk) => {
        this.logs += String(chunk);
      });
      child.stderr!.on('data', (chunk) => {
        this.logs += String(chunk);
      });
      await once(child, 'spawn');
      await this.beforeIdentity?.();
      this.childProof = await processIdentity(child.pid!);
      await this.record();
      this.assertOpen();
    })();
    try {
      await this.spawning;
    } finally {
      this.spawning = undefined;
    }
  }
  async start() {
    this.assertOpen();
    await this.spawn();
    this.assertOpen();
    await until(
      async () => {
        this.assertOpen();
        if (this.child!.exitCode !== null) throw new Error(this.logs);
        return fetch(`${this.url}/health/live`, {
          signal: AbortSignal.timeout(1000),
        });
      },
      (response) => response.ok,
    );
    this.assertOpen();
    return this;
  }
  async stop(signal: NodeJS.Signals = 'SIGTERM') {
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill(signal);
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(deadline);
    }
    if (this.evidence)
      await appendFile(join(this.evidence, 'server.log'), this.logs);
    this.child = undefined;
    this.childProof = undefined;
    this.launchIntent = undefined;
    if (this.evidence) await this.record();
  }
  async cleanup() {
    this.closed = true;
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      await this.creating?.catch(() => {});
      await this.spawning?.catch(() => {});
      await this.stop();
      if (this.directory) await removeOwnedDirectory(this.ledger());
      this.directory = '';
      if (this.evidence) await this.record();
      owned.delete(this);
    })();
    try {
      await this.cleanupPromise;
    } catch (error) {
      this.cleanupPromise = undefined;
      throw error;
    }
  }
}
