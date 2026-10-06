import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdir, rename, rm, stat, link, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { BlobStore } from './context.ts';

export class BlobMissing extends Error {}
export class BlobChanged extends Error {}
export class BlobTooLarge extends Error {}
export class BlobChecksumMismatch extends Error {}
export type BlobDigest = {
  key: string;
  sha256: string;
  size: number;
  prefix: Buffer;
};
export type BlobEntry = {
  key: string;
  kind: 'staging' | 'object' | 'temporary' | 'unknown';
  modifiedAt: number;
  active: boolean;
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
    expectedSha256?: string,
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
        const sha256 = hash.digest('hex');
        if (expectedSha256 !== undefined && sha256 !== expectedSha256)
          throw new BlobChecksumMismatch('Upload checksum does not match');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, destination);
        await this.syncDirectory(dirname(destination));
        return { key, sha256, size, prefix };
      } finally {
        try {
          await handle?.close();
          await rm(temporary, { force: true });
        } finally {
          this.writing.delete(temporary);
        }
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
    this.writing.add(temporary);
    try {
      await link(this.path(stagedKey), temporary);
      await rename(temporary, destination);
      await this.syncDirectory(dirname(destination));
    } finally {
      try {
        await rm(temporary, { force: true });
      } finally {
        this.writing.delete(temporary);
      }
    }
    return key;
  }
  async *read(key: string): AsyncIterable<Uint8Array> {
    yield* createReadStream(this.path(key));
  }
  async remove(key: string) {
    await this.withLock(key, async () => {
      await rm(this.path(key), { force: true });
      try {
        await this.syncDirectory(dirname(this.path(key)));
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    });
  }
  async entries(after: string, limit: number): Promise<BlobEntry[]> {
    const keys: string[] = [];
    for (const folder of ['staging', 'temporary'])
      for (const entry of await readdir(join(this.directory, folder), {
        withFileTypes: true,
      }))
        keys.push(`${folder}/${entry.name}`);
    for (const prefix of await readdir(join(this.directory, 'objects'), {
      withFileTypes: true,
    })) {
      if (prefix.isDirectory() && /^[0-9a-f]{2}$/.test(prefix.name))
        for (const entry of await readdir(
          join(this.directory, 'objects', prefix.name),
          { withFileTypes: true },
        ))
          keys.push(`objects/${prefix.name}/${entry.name}`);
      else keys.push(`objects/${prefix.name}`);
    }
    keys.sort();
    let selected = keys.filter((key) => key > after).slice(0, limit);
    if (!selected.length && after) selected = keys.slice(0, limit);
    const entries: BlobEntry[] = [];
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    for (const key of selected) {
      const path = join(this.directory, key);
      let details: Awaited<ReturnType<typeof stat>>;
      try {
        details = await stat(path);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          continue;
        throw error;
      }
      const object = /^objects\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(key);
      const kind = !details.isFile()
        ? 'unknown'
        : new RegExp(`^staging/${uuid}$`).test(key)
          ? 'staging'
          : new RegExp(`^(temporary|objects/[0-9a-f]{2})/${uuid}\\.part$`).test(
                key,
              )
            ? 'temporary'
            : object && object[1] === object[2].slice(0, 2)
              ? 'object'
              : 'unknown';
      entries.push({
        key,
        kind,
        modifiedAt: details.mtimeMs,
        active: this.writing.has(path),
      });
    }
    return entries;
  }
  async removeTemporary(entry: BlobEntry) {
    if (entry.kind !== 'temporary')
      throw new BlobChanged('Content is not a managed temporary file');
    const path = join(this.directory, entry.key);
    if (this.writing.has(path)) return false;
    await rm(path, { force: true });
    return true;
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
