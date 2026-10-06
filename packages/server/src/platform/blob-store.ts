import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdir, rename, rm, stat, link } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { BlobStore } from './context.ts';

export class BlobMissing extends Error {}
export class BlobChanged extends Error {}
export class BlobTooLarge extends Error {}
export type BlobDigest = {
  key: string;
  sha256: string;
  size: number;
  prefix: Buffer;
};
export class LocalBlobStore implements BlobStore {
  directory: string;
  private locks = new Map<string, Promise<void>>();
  private writing = new Set<string>();
  constructor(directory: string) {
    this.directory = directory;
  }
  async initialize() {
    for (const folder of ['staging', 'temporary', 'objects'])
      await mkdir(join(this.directory, folder), { recursive: true });
  }
  private path(key: string) {
    if (
      !/^(staging\/[0-9a-f-]{36}|objects\/[0-9a-f]{2}\/[0-9a-f]{64})$/.test(key)
    )
      throw new BlobMissing('Invalid content location');
    return join(this.directory, key);
  }
  async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
  withHash<T>(sha256: string, work: () => Promise<T>) {
    return this.withLock(`hash:${sha256}`, work);
  }
  async stage(content: AsyncIterable<Uint8Array>, maximumBytes: number) {
    return this.stageAt(`staging/${randomUUID()}`, content, maximumBytes);
  }
  async stageAt(
    key: string,
    content: AsyncIterable<Uint8Array>,
    maximumBytes: number,
  ): Promise<BlobDigest> {
    return this.withLock(key, async () => {
      const destination = this.path(key);
      try {
        await stat(destination);
        throw new BlobChanged('Staging content is immutable');
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
      const temporary = join(
        this.directory,
        'temporary',
        `${randomUUID()}.part`,
      );
      this.writing.add(temporary);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', 0o600);
        const hash = createHash('sha256');
        let size = 0;
        let prefix = Buffer.alloc(0);
        for await (const chunk of content) {
          size += chunk.byteLength;
          if (size > maximumBytes)
            throw new BlobTooLarge('Content exceeds the maximum size');
          hash.update(chunk);
          if (prefix.length < 16)
            prefix = Buffer.concat([
              prefix,
              Buffer.from(chunk).subarray(0, 16 - prefix.length),
            ]);
          let written = 0;
          while (written < chunk.byteLength)
            written += (
              await handle.write(chunk, written, chunk.byteLength - written)
            ).bytesWritten;
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, destination);
        await this.syncDirectory(dirname(destination));
        return { key, sha256: hash.digest('hex'), size, prefix };
      } finally {
        await handle?.close();
        await rm(temporary, { force: true });
        this.writing.delete(temporary);
      }
    });
  }
  async inspect(key: string, maximumBytes: number): Promise<BlobDigest> {
    const hash = createHash('sha256');
    let size = 0;
    let prefix = Buffer.alloc(0);
    try {
      for await (const chunk of this.read(key)) {
        size += chunk.byteLength;
        if (size > maximumBytes)
          throw new BlobTooLarge('Content exceeds the maximum size');
        hash.update(chunk);
        if (prefix.length < 16)
          prefix = Buffer.concat([
            prefix,
            Buffer.from(chunk).subarray(0, 16 - prefix.length),
          ]);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new BlobMissing('Content is unavailable');
      throw error;
    }
    return { key, sha256: hash.digest('hex'), size, prefix };
  }
  // FileService owns hash lock -> DB publication/GC ordering.
  async adopt(stagedKey: string, sha256: string) {
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new BlobChanged('Invalid content hash');
    const key = `objects/${sha256.slice(0, 2)}/${sha256}`;
    const destination = this.path(key);
    await mkdir(dirname(destination), { recursive: true });
    try {
      const existing = await this.inspect(key, Number.MAX_SAFE_INTEGER);
      if (existing.sha256 !== sha256)
        throw new BlobChanged('Stored content hash changed');
      return key;
    } catch (error) {
      if (!(error instanceof BlobMissing)) throw error;
    }
    const temporary = join(dirname(destination), `${randomUUID()}.part`);
    try {
      await link(this.path(stagedKey), temporary);
      await rename(temporary, destination);
      await this.syncDirectory(dirname(destination));
    } finally {
      await rm(temporary, { force: true });
    }
    return key;
  }
  async *read(key: string): AsyncIterable<Uint8Array> {
    yield* createReadStream(this.path(key));
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
    await this.syncDirectory(dirname(this.path(key)));
  }
  private async syncDirectory(directory: string) {
    if (process.platform === 'win32') return; // Windows does not open directories for fsync.
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
