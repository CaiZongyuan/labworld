import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { basename, dirname, resolve } from 'node:path';

export async function canonicalPath(path: string) {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      if (dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

export class DirectoryLease {
  private server: Server;
  readonly directory: string;
  private releasing = false;
  private lost?: () => void;
  private constructor(directory: string, server: Server) {
    this.directory = directory;
    this.server = server;
  }
  static async acquire(directory: string) {
    const lease = await DirectoryLease.reserve(directory);
    try {
      await mkdir(lease.directory, { recursive: true });
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }
  // Hold the same canonical exclusion before an atomic directory publication,
  // without creating or changing the destination.
  static async reserve(directory: string) {
    const canonical = await canonicalPath(directory);
    const digest = createHash('sha256')
      .update(
        process.platform === 'win32' ? canonical.toLowerCase() : canonical,
      )
      .digest('hex');
    const address =
      process.platform === 'linux'
        ? `\0lab-word-${digest}`
        : process.platform === 'win32'
          ? `\\\\.\\pipe\\lab-word-${digest}`
          : undefined;
    if (!address)
      throw new Error(
        'Data-directory exclusivity currently supports Linux and Windows',
      );
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const lease = new DirectoryLease(canonical, server);
    server.on('error', () => lease.lost?.());
    server.on('close', () => {
      if (!lease.releasing) lease.lost?.();
    });
    return lease;
  }
  onLost(handler: () => void) {
    this.lost = handler;
  }
  async release() {
    this.releasing = true;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
