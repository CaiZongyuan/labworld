import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Database } from '../../../packages/server/src/platform/db/index.ts';
import { DirectoryLease } from '../../../packages/server/src/platform/db/lease.ts';
import { copyDatabaseSnapshot } from '../../../packages/server/src/platform/db/snapshot.ts';
import {
  readyArchiveFiles,
  type ReadyArchiveFile,
} from '../../../packages/server/src/core/files/archive.ts';
import { LocalBlobStore } from '../../../packages/server/src/platform/blob-store.ts';

type Entry = { path: string; size: number; sha256: string };
type Manifest = {
  format: 'lab-word-node-directory-v1';
  createdAt: string;
  database: Awaited<ReturnType<Database['archiveFacts']>>;
  readyFiles: ReadyArchiveFile[];
  directories: string[];
  entries: Entry[];
};
async function digest(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Archive requires regular files');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}
async function entries(
  root: string,
  prefix: string,
  directories: string[],
): Promise<Entry[]> {
  directories.push(prefix);
  const folder = join(root, prefix),
    result: Entry[] = [];
  for (const name of await readdir(folder)) {
    const path = prefix + '/' + name,
      info = await lstat(join(root, path));
    if (info.isSymbolicLink())
      throw new Error('Archive links are not supported');
    if (info.isDirectory())
      result.push(...(await entries(root, path, directories)));
    else result.push({ path, ...(await digest(join(root, path))) });
  }
  return result;
}
async function absentOrEmpty(path: string) {
  try {
    if (!(await lstat(path)).isDirectory() || (await readdir(path)).length)
      throw new Error('Destination must be new or empty');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}
export async function backup(directory: string, output: string) {
  output = resolve(output);
  await absentOrEmpty(output);
  const lease = await DirectoryLease.acquire(directory),
    db = new Database(lease);
  let staging: string | undefined;
  try {
    await db.openExisting();
    const facts = await db.archiveFacts(),
      files: ReadyArchiveFile[] = [],
      blobs = new LocalBlobStore(join(directory, 'blobs'));
    for await (const file of readyArchiveFiles(db)) {
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
    await mkdir(dirname(output), { recursive: true });
    staging = await mkdtemp(join(dirname(output), '.lab-word-backup-'));
    await copyDatabaseSnapshot(lease, join(staging, 'pgdata'));
    for (const file of files) {
      const target = join(staging, 'blobs', file.key);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(directory, 'blobs', file.key), target);
      const actual = await digest(target);
      if (actual.size !== file.size || actual.sha256 !== file.sha256)
        throw new Error('Ready file changed during snapshot');
    }
    const directories: string[] = [];
    const databaseEntries = await entries(staging, 'pgdata', directories);
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
    await absentOrEmpty(output);
    try {
      await rm(output);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    await rename(staging, output);
    staging = undefined;
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
        if (staging) await rm(staging, { recursive: true, force: true });
      } finally {
        await lease.release();
      }
    }
  }
}
export async function restore(directory: string, archive: string) {
  archive = resolve(archive);
  const manifest = JSON.parse(
    await readFile(join(archive, 'manifest.json'), 'utf8'),
  ) as Manifest;
  if (
    manifest.format !== 'lab-word-node-directory-v1' ||
    !Array.isArray(manifest.directories) ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.readyFiles)
  )
    throw new Error('Unsupported archive format');
  for (const path of manifest.directories)
    if (
      !/^pgdata(?:\/[A-Za-z0-9_./-]+)?$/.test(path) ||
      path.split('/').some((part) => part === '..' || part === '.' || !part)
    )
      throw new Error('Invalid database directory');
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
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
    const actual = await digest(join(archive, entry.path));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256)
      throw new Error('Archive content does not match manifest');
  }
  await absentOrEmpty(directory);
  await mkdir(dirname(resolve(directory)), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(resolve(directory)), '.lab-word-restore-'),
  );
  let stageLease: DirectoryLease | undefined,
    db: Database | undefined,
    targetLease: DirectoryLease | undefined;
  try {
    for (const path of manifest.directories)
      await mkdir(join(staging, path), { recursive: true, mode: 0o700 });
    for (const entry of manifest.entries) {
      const target = join(staging, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(archive, entry.path), target);
    }
    stageLease = await DirectoryLease.acquire(staging);
    db = new Database(stageLease);
    await db.openExisting();
    const actual = await db.archiveFacts();
    if (JSON.stringify(actual) !== JSON.stringify(manifest.database))
      throw new Error('Unsupported archive database history or engine');
    const files: ReadyArchiveFile[] = [];
    for await (const file of readyArchiveFiles(db)) files.push(file);
    if (JSON.stringify(files) !== JSON.stringify(manifest.readyFiles))
      throw new Error('Archive file references do not match database');
    const blobs = new LocalBlobStore(join(staging, 'blobs'));
    for (const file of files) {
      const content = await blobs.inspect(file.key, file.size);
      if (content.sha256 !== file.sha256 || content.size !== file.size)
        throw new Error('Restored ready file is invalid');
    }
    await db.close();
    await stageLease.release();
    stageLease = undefined;
    targetLease = await DirectoryLease.acquire(directory);
    await absentOrEmpty(directory);
    // Keep the target's canonical lease while publishing its validated children.
    for (const name of await readdir(staging))
      await rename(join(staging, name), join(directory, name));
    return {
      status: 'restored',
      format: manifest.format,
      schemaVersion: actual.schemaVersion,
      files: files.length,
    };
  } finally {
    try {
      await db?.close();
    } finally {
      try {
        await stageLease?.release();
      } finally {
        try {
          await rm(staging, { recursive: true, force: true });
        } finally {
          await targetLease?.release();
        }
      }
    }
  }
}
