import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DirectoryLease } from '../../../packages/server/src/platform/db/lease.ts';

type Ledger = {
  owner: 'lab-word-node-archive-v1';
  destination: string;
  stage: string;
  emptyMode?: number;
  identity?: { dev: string; ino: string; birthtimeNs: string };
};
const stageName = /^\.lab-word-(?:backup|restore)-[0-9a-f-]{36}$/;
async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}
async function emptyDestination(path: string) {
  const info = await existing(path);
  if (info && (!info.isDirectory() || (await readdir(path)).length))
    throw new Error('Destination must be new or empty');
  return info;
}
async function record(path: string, ledger: Ledger) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(ledger) + '\n');
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  } finally {
    await file.close();
  }
}
async function restoreEmpty(ledger: Ledger) {
  if (ledger.emptyMode !== undefined && !(await existing(ledger.destination)))
    await mkdir(ledger.destination, { mode: ledger.emptyMode });
}
async function createdIdentity(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Owned archive staging changed kind; operation refused');
  if (info.ino === 0n || info.birthtimeNs === 0n)
    throw new Error('Archive staging creation identity is unavailable');
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    birthtimeNs: info.birthtimeNs.toString(),
  };
}
async function verifyIdentity(ledger: Ledger) {
  const actual = await createdIdentity(ledger.stage);
  if (
    !ledger.identity ||
    actual.dev !== ledger.identity.dev ||
    actual.ino !== ledger.identity.ino ||
    actual.birthtimeNs !== ledger.identity.birthtimeNs
  )
    throw new Error(
      'Owned archive staging identity changed or is missing; operation refused',
    );
}
async function recover(destination: string, assertOwned: () => void) {
  const parent = dirname(destination);
  for (const name of await readdir(parent)) {
    if (!name.endsWith('.json') || !stageName.test(name.slice(0, -5))) continue;
    const marker = join(parent, name),
      info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    let ledger: Ledger;
    try {
      ledger = JSON.parse(await readFile(marker, 'utf8')) as Ledger;
    } catch {
      continue;
    }
    if (
      ledger?.owner !== 'lab-word-node-archive-v1' ||
      ledger.destination !== destination ||
      ledger.stage !== join(parent, name.slice(0, -5)) ||
      (ledger.emptyMode !== undefined &&
        (!Number.isInteger(ledger.emptyMode) || ledger.emptyMode < 0))
    )
      continue;
    // Destination exclusion alone cannot prove a stage consumer has stopped.
    const lease = await DirectoryLease.reserve(ledger.stage);
    let lost = false;
    lease.onLost(() => {
      lost = true;
    });
    const check = () => {
      assertOwned();
      if (lost)
        throw new Error('Archive staging ownership was lost; recovery refused');
    };
    try {
      try {
        const stage = await existing(ledger.stage);
        if (stage) {
          await verifyIdentity(ledger);
          check();
          await rm(ledger.stage, { recursive: true });
        }
      } finally {
        // A refused stage is preserved; its recorded empty target can still
        // be restored while destination exclusion remains valid.
        assertOwned();
        await restoreEmpty(ledger);
      }
      await rm(marker + '.next', { force: true });
      await rm(marker);
    } finally {
      await lease.release();
    }
  }
}

/** Own one validated-directory publication, including interrupted-run recovery. */
export class ArchiveWorkspace {
  readonly path: string;
  readonly lease: DirectoryLease;
  private destinationLease: DirectoryLease;
  private ledger: Ledger;
  private marker: string;
  private closing?: Promise<void>;
  private destinationLost = false;
  private stageLost = false;
  private lostHandler?: () => void;
  private constructor(
    destinationLease: DirectoryLease,
    stageLease: DirectoryLease,
    ledger: Ledger,
  ) {
    this.destinationLease = destinationLease;
    this.lease = stageLease;
    this.ledger = ledger;
    this.path = ledger.stage;
    this.marker = ledger.stage + '.json';
    destinationLease.onLost(() => {
      this.destinationLost = true;
      this.lostHandler?.();
    });
    stageLease.onLost(() => {
      this.stageLost = true;
      this.lostHandler?.();
    });
  }
  static async create(kind: 'backup' | 'restore', destination: string) {
    await mkdir(dirname(resolve(destination)), { recursive: true });
    const target = await DirectoryLease.reserve(destination);
    let stage: DirectoryLease | undefined,
      marker: string | undefined,
      path: string | undefined,
      created = false,
      lost = false,
      ledger: Ledger | undefined;
    const check = () => {
      if (lost) throw new Error('Archive directory ownership was lost');
    };
    target.onLost(() => {
      lost = true;
    });
    try {
      await recover(target.directory, check);
      await emptyDestination(target.directory);
      path = join(
        dirname(target.directory),
        '.lab-word-' + kind + '-' + randomUUID(),
      );
      stage = await DirectoryLease.reserve(path);
      stage.onLost(() => {
        lost = true;
      });
      ledger = {
        owner: 'lab-word-node-archive-v1',
        destination: target.directory,
        stage: path,
      };
      // Publish ownership before creating the disposable directory, so an
      // abrupt process exit cannot leave an unrecorded copied-data stage.
      await record(path + '.json', ledger);
      marker = path + '.json';
      check();
      await mkdir(path, { mode: 0o700 });
      created = true;
      ledger.identity = await createdIdentity(path);
      await record(marker + '.next', ledger);
      await rename(marker + '.next', marker);
      check();
      return new ArchiveWorkspace(target, stage, ledger);
    } catch (error) {
      try {
        if (created) {
          await verifyIdentity(ledger!);
          check();
          await rm(path!, { recursive: true });
        }
        if (marker) await rm(marker + '.next', { force: true });
        if (marker) await rm(marker, { force: true });
      } finally {
        try {
          await stage?.release();
        } finally {
          await target.release();
        }
      }
      throw error;
    }
  }
  onLost(handler: () => void) {
    this.lostHandler = handler;
  }
  private assertDestination() {
    if (this.destinationLost)
      throw new Error('Archive destination ownership was lost');
  }
  private assertOwned() {
    this.assertDestination();
    if (this.stageLost) throw new Error('Archive staging ownership was lost');
  }
  async publish(signal?: AbortSignal) {
    this.assertOwned();
    signal?.throwIfAborted();
    const empty = await emptyDestination(this.ledger.destination);
    this.ledger.emptyMode = empty?.mode;
    await record(this.marker + '.next', this.ledger);
    await rename(this.marker + '.next', this.marker);
    signal?.throwIfAborted();
    await verifyIdentity(this.ledger);
    this.assertOwned();
    if (empty) await rmdir(this.ledger.destination);
    signal?.throwIfAborted();
    await verifyIdentity(this.ledger);
    this.assertOwned();
    await rename(this.path, this.ledger.destination);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        try {
          this.assertOwned();
          const stage = await existing(this.path);
          if (stage) {
            await verifyIdentity(this.ledger);
            this.assertOwned();
            await rm(this.path, { recursive: true });
          }
        } finally {
          this.assertDestination();
          await restoreEmpty(this.ledger);
        }
        await rm(this.marker + '.next', { force: true });
        await rm(this.marker, { force: true });
      } finally {
        try {
          await this.lease.release();
        } finally {
          await this.destinationLease.release();
        }
      }
    })();
    return this.closing;
  }
}
