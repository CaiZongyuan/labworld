import { join } from 'node:path';
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import type { DirectoryLease } from './lease.ts';

/** Copy a closed database while its caller retains directory exclusion. */
export async function copyDatabaseSnapshot(
  lease: DirectoryLease,
  destination: string,
) {
  async function copy(source: string, target: string) {
    const info = await lstat(source);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error('Database snapshot contains a link or unsupported entry');
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true });
      for (const name of await readdir(source))
        await copy(join(source, name), join(target, name));
    } else await copyFile(source, target);
  }
  await copy(join(lease.directory, 'pgdata'), destination);
}
