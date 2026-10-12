import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eventPosition } from './event-page.ts';

const absent = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;
/** Lab owns this key; backup copies only pgdata/blobs and deliberately excludes it. */
export async function recordingEventCursorKey(root: string) {
  const directory = join(root, 'secrets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink())
    throw new Error('recording_cursor_key_invalid');
  const path = join(directory, 'recording-events-cursor-key');
  const load = async () => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 32)
      throw new Error('recording_cursor_key_invalid');
    const key = await readFile(path);
    if (key.length !== 32) throw new Error('recording_cursor_key_invalid');
    return key;
  };
  try {
    return await load();
  } catch (error) {
    if (!absent(error, 'ENOENT')) throw error;
  }
  const temporary = join(
    directory,
    `recording-events-cursor-key.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!absent(error, 'EEXIST')) throw error;
    }
    if (process.platform !== 'win32') {
      const folderHandle = await open(directory, 'r');
      try {
        await folderHandle.sync();
      } finally {
        await folderHandle.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return load();
}

export class RecordingEventCursors {
  private key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('recording_cursor_key_invalid');
    this.key = Buffer.from(key);
  }
  private mac(payload: string) {
    return createHmac('sha256', this.key)
      .update('Lab Word Recording.events cursor v1\0')
      .update(payload)
      .digest();
  }
  encode(position: ReturnType<typeof eventPosition>) {
    const payload = Buffer.from(JSON.stringify(position)).toString('base64url');
    const value = Buffer.from(
      JSON.stringify({
        v: 1,
        p: payload,
        m: this.mac(payload).toString('base64url'),
      }),
    ).toString('base64url');
    if (value.length > 2048) throw new Error('recording_invalid_cursor');
    return value;
  }
  decode(raw: string | undefined, id: string) {
    if (!raw)
      return eventPosition({ recording_id: id, ordinal: '0', index: -1 }, id);
    try {
      if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (value.v === 1) {
        if (
          typeof value.p !== 'string' ||
          typeof value.m !== 'string' ||
          !/^[A-Za-z0-9_-]+$/.test(value.p) ||
          !/^[A-Za-z0-9_-]+$/.test(value.m)
        )
          throw new Error();
        const supplied = Buffer.from(value.m, 'base64url');
        if (
          supplied.length !== 32 ||
          !timingSafeEqual(supplied, this.mac(value.p))
        )
          throw new Error();
        return eventPosition(
          JSON.parse(Buffer.from(value.p, 'base64url').toString('utf8')),
          id,
        );
      }
      // Old positions are not trusted physical/prepare evidence: replay the prefix.
      if (Object.keys(value).sort().join(',') !== 'index,ordinal,recording_id')
        throw new Error();
      return eventPosition(value, id);
    } catch {
      throw new Error('recording_invalid_cursor');
    }
  }
}
