import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  Database,
  sql,
} from '../../../packages/server/src/platform/db/index.ts';
import {
  canonicalPath,
  DirectoryLease,
} from '../../../packages/server/src/platform/db/lease.ts';
import { copyDatabaseSnapshot } from '../../../packages/server/src/platform/db/snapshot.ts';
import {
  readyArchiveFiles,
  type ReadyArchiveFile,
} from '../../../packages/server/src/core/files/archive.ts';
import { LocalBlobStore } from '../../../packages/server/src/platform/blob-store.ts';
import { ArchiveWorkspace } from './archive-workspace.ts';
import { configuration } from './config.ts';
import { FileService } from '../../../packages/server/src/core/files/use-cases.ts';
import { WorldService } from '../../../packages/server/src/lab/world/use-cases.ts';
import { DeviceRuntime } from '../../../packages/server/src/lab/devices/runtime.ts';
import { SimulationSessions } from '../../../packages/server/src/lab/sessions/service.ts';
import {
  RecordingService,
  defaultRecordingOptions,
} from '../../../packages/server/src/lab/recordings/service.ts';

type Entry = { path: string; size: number; sha256: string };
type Manifest = {
  format: 'lab-word-node-directory-v1';
  createdAt: string;
  database: Awaited<ReturnType<Database['archiveFacts']>>;
  readyFiles: ReadyArchiveFile[];
  directories: string[];
  entries: Entry[];
};
async function archivePath(
  root: string,
  path: string,
  kind: 'file' | 'directory',
) {
  let current = root;
  const parts = path.split('/');
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error('Archive links are not supported');
    const directory = index < parts.length - 1 || kind === 'directory';
    if (directory ? !info.isDirectory() : !info.isFile())
      throw new Error('Archive entry has the wrong kind');
  }
  return current;
}
async function digest(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Archive requires regular files');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}
async function entries(
  root: string,
  prefix: string,
  directories: string[],
  signal?: AbortSignal,
): Promise<Entry[]> {
  signal?.throwIfAborted();
  directories.push(prefix);
  const folder = join(root, prefix),
    result: Entry[] = [];
  for (const name of await readdir(folder)) {
    const path = prefix + '/' + name,
      info = await lstat(join(root, path));
    if (info.isSymbolicLink())
      throw new Error('Archive links are not supported');
    if (info.isDirectory())
      result.push(...(await entries(root, path, directories, signal)));
    else result.push({ path, ...(await digest(join(root, path), signal)) });
  }
  return result;
}
function within(root: string, path: string) {
  if (process.platform === 'win32') {
    root = root.toLowerCase();
    path = path.toLowerCase();
  }
  const child = relative(root, path);
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep))
  );
}
async function recoverRecordingsForBackup(
  db: Database,
  directory: string,
  signal?: AbortSignal,
) {
  const table = await db.read(
    { id: 'backup:recording-schema', kind: 'startup' },
    (tx) =>
      tx.execute<{ present: boolean }>(
        sql`select to_regclass('lab.recordings') is not null as present`,
      ),
  );
  if (!table.rows[0].present) return;
  const config = configuration();
  const context = { db, clock: { now: () => new Date().toISOString() } };
  const files = new FileService(
    context,
    config.files,
    config.auth,
    config.fileOrigin,
    directory,
  );
  const world = new WorldService(context, config.auth);
  const recording = new RecordingService(world, files, directory, {
    ...defaultRecordingOptions,
    ackMillis: config.motionAckMillis,
    graceMillis: config.motionGraceMillis,
  });
  const devices = new DeviceRuntime(context, undefined, recording.capture);
  const sessions = new SimulationSessions(world, {
    enabled: false,
    ackMillis: config.motionAckMillis,
    graceMillis: config.motionGraceMillis,
  });
  sessions.configureRecording(recording);
  const errors: unknown[] = [];
  try {
    signal?.throwIfAborted();
    await files.initialize();
    await recording.initialize();
    // Preserve old capture owners through exact Device and Session recovery.
    await devices.initialize();
    await sessions.initialize();
    await recording.recoverLegacy();
    signal?.throwIfAborted();
    await recording.sealForBackup();
  } catch (error) {
    errors.push(error);
  } finally {
    sessions.quiesce();
    for (const closeOwner of [
      () => devices.stop(),
      () => sessions.stop(),
      () => recording.stop(),
    ]) {
      try {
        await closeOwner();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Recording recovery prevented backup');
}
export async function backup(
  directory: string,
  output: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  output = resolve(output);
  const databaseTree = await canonicalPath(join(directory, 'pgdata')),
    publication = await canonicalPath(output),
    stagingParent = await canonicalPath(dirname(output));
  if (
    within(databaseTree, publication) ||
    within(publication, databaseTree) ||
    within(databaseTree, stagingParent)
  )
    throw new Error(
      'Backup output or staging would overlap the database snapshot tree',
    );
  const lease = await DirectoryLease.acquire(directory),
    db = new Database(lease);
  lease.onLost(() => db.loseLease());
  let workspace: ArchiveWorkspace | undefined;
  try {
    await db.openExisting();
    // Acknowledged WAL bytes must be adopted before the ready-file inventory.
    // Any recovery/seal error leaves the archive unpublished.
    await recoverRecordingsForBackup(db, directory, signal);
    const facts = await db.archiveFacts(),
      files: ReadyArchiveFile[] = [],
      blobs = new LocalBlobStore(join(directory, 'blobs'));
    for await (const file of readyArchiveFiles(db)) {
      signal?.throwIfAborted();
      const actual = await blobs.inspect(file.key, file.size);
      if (
        actual.size !== file.size ||
        actual.sha256 !== file.sha256 ||
        file.key !== 'objects/' + file.sha256.slice(0, 2) + '/' + file.sha256
      )
        throw new Error('Ready file content does not match its metadata');
      files.push(file);
    }
    await db.close();
    signal?.throwIfAborted();
    workspace = await ArchiveWorkspace.create('backup', output);
    const staging = workspace.path;
    await copyDatabaseSnapshot(lease, join(staging, 'pgdata'), signal);
    for (const file of files) {
      signal?.throwIfAborted();
      const target = join(staging, 'blobs', file.key);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(directory, 'blobs', file.key), target);
      const actual = await digest(target, signal);
      if (actual.size !== file.size || actual.sha256 !== file.sha256)
        throw new Error('Ready file changed during snapshot');
    }
    const directories: string[] = [];
    const databaseEntries = await entries(
      staging,
      'pgdata',
      directories,
      signal,
    );
    const manifest: Manifest = {
      format: 'lab-word-node-directory-v1',
      createdAt: new Date().toISOString(),
      database: facts,
      readyFiles: files,
      directories,
      entries: [
        ...databaseEntries,
        ...files
          .filter(
            (file, index) =>
              files.findIndex((other) => other.key === file.key) === index,
          )
          .map((file) => ({
            path: 'blobs/' + file.key,
            size: file.size,
            sha256: file.sha256,
          })),
      ],
    };
    await writeFile(
      join(staging, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    await workspace.publish(signal);
    return {
      status: 'backed-up',
      format: manifest.format,
      schemaVersion: facts.schemaVersion,
      files: files.length,
    };
  } finally {
    try {
      await db.close();
    } finally {
      try {
        await workspace?.close();
      } finally {
        await lease.release();
      }
    }
  }
}
export async function restore(
  directory: string,
  archive: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  archive = resolve(archive);
  const manifest = JSON.parse(
    await readFile(await archivePath(archive, 'manifest.json', 'file'), 'utf8'),
  ) as Manifest;
  if (
    manifest.format !== 'lab-word-node-directory-v1' ||
    !Array.isArray(manifest.directories) ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.readyFiles)
  )
    throw new Error('Unsupported archive format');
  for (const path of manifest.directories) {
    signal?.throwIfAborted();
    if (
      !/^pgdata(?:\/[A-Za-z0-9_./-]+)?$/.test(path) ||
      path.split('/').some((part) => part === '..' || part === '.' || !part)
    )
      throw new Error('Invalid database directory');
    await archivePath(archive, path, 'directory');
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    if (
      !/^(pgdata\/[A-Za-z0-9_./-]+|blobs\/objects\/[0-9a-f]{2}\/[0-9a-f]{64})$/.test(
        entry.path,
      ) ||
      entry.path
        .split('/')
        .some((part) => part === '..' || part === '.' || !part) ||
      seen.has(entry.path)
    )
      throw new Error('Invalid archive entry');
    seen.add(entry.path);
    const actual = await digest(
      await archivePath(archive, entry.path, 'file'),
      signal,
    );
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256)
      throw new Error('Archive content does not match manifest');
  }
  const workspace = await ArchiveWorkspace.create('restore', directory),
    staging = workspace.path;
  let db: Database | undefined;
  try {
    for (const path of manifest.directories)
      await mkdir(join(staging, path), { recursive: true, mode: 0o700 });
    for (const entry of manifest.entries) {
      signal?.throwIfAborted();
      const target = join(staging, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(archive, entry.path), target);
      const copied = await digest(target, signal);
      if (copied.size !== entry.size || copied.sha256 !== entry.sha256)
        throw new Error('Staged archive content does not match manifest');
    }
    db = new Database(workspace.lease);
    workspace.onLost(() => db?.loseLease());
    await db.openExisting();
    const actual = await db.archiveFacts();
    if (JSON.stringify(actual) !== JSON.stringify(manifest.database))
      throw new Error('Unsupported archive database history or engine');
    const files: ReadyArchiveFile[] = [];
    for await (const file of readyArchiveFiles(db)) {
      signal?.throwIfAborted();
      files.push(file);
    }
    if (JSON.stringify(files) !== JSON.stringify(manifest.readyFiles))
      throw new Error('Archive file references do not match database');
    const blobs = new LocalBlobStore(join(staging, 'blobs'));
    for (const file of files) {
      signal?.throwIfAborted();
      const content = await blobs.inspect(file.key, file.size);
      if (content.sha256 !== file.sha256 || content.size !== file.size)
        throw new Error('Restored ready file is invalid');
    }
    await db.close();
    db = new Database(workspace.lease);
    await db.initialize();
    const upgraded = await db.archiveFacts();
    await db.close();
    await workspace.publish(signal);
    return {
      status: 'restored',
      format: manifest.format,
      schemaVersion: upgraded.schemaVersion,
      files: files.length,
    };
  } finally {
    try {
      await db?.close();
    } finally {
      await workspace.close();
    }
  }
}
