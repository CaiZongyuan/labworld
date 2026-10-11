import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { waitRecordingFault, type RecordingFaults } from './source.ts';

export const journalDigest = (bytes: Uint8Array) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
export type JournalRecord = {
  ordinal: string;
  kind: string;
  recorded_at: string;
  data: Record<string, unknown>;
};
export type JournalSegment = {
  id: string;
  index: number;
  size: number;
  sha256: string;
  first_ordinal: string;
  last_ordinal: string;
  sealed: boolean;
  path: string;
};
const maxRecordBytes = 128 * 1024;
const segmentName = /^(\d{6})-([0-9a-f-]{36})\.lwf$/;
const quarantineName = /^quarantine-[0-9a-f-]{36}\.bin$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** The bytes exposed by segment reads: LE length, SHA-256, exact UTF-8 JSON. */
export function encodeJournalRecord(record: JournalRecord) {
  const payload = Buffer.from(JSON.stringify(record));
  if (payload.length > maxRecordBytes)
    throw new Error('recording_event_capacity');
  const header = Buffer.alloc(36);
  header.writeUInt32LE(payload.length);
  createHash('sha256').update(payload).digest().copy(header, 4);
  return Buffer.concat([header, payload]);
}
export function decodeJournalBytes(bytes: Uint8Array): JournalRecord[] {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    records: JournalRecord[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (data.length - offset < 36) throw new Error('recording_torn_tail');
    const size = data.readUInt32LE(offset);
    if (!size || size > maxRecordBytes || offset + 36 + size > data.length)
      throw new Error('recording_torn_tail');
    const payload = data.subarray(offset + 36, offset + 36 + size);
    if (
      !createHash('sha256')
        .update(payload)
        .digest()
        .equals(data.subarray(offset + 4, offset + 36))
    )
      throw new Error('recording_corrupt_tail');
    records.push(JSON.parse(payload.toString('utf8')) as JournalRecord);
    offset += 36 + size;
  }
  return records;
}
export async function* readJournal(
  path: string,
  limit?: number,
): AsyncGenerator<JournalRecord> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('recording_owned_file_changed');
  const handle = await open(path, 'r');
  const end = Math.min(info.size, limit ?? info.size);
  let offset = 0;
  const exact = async (size: number) => {
    const bytes = Buffer.alloc(size);
    let done = 0;
    while (done < size) {
      const n = (await handle.read(bytes, done, size - done, offset + done))
        .bytesRead;
      if (!n) throw new Error('recording_torn_tail');
      done += n;
    }
    offset += size;
    return bytes;
  };
  try {
    while (offset < end) {
      if (end - offset < 36) throw new Error('recording_torn_tail');
      const header = await exact(36),
        size = header.readUInt32LE();
      if (!size || size > maxRecordBytes || size > end - offset)
        throw new Error('recording_torn_tail');
      const payload = await exact(size);
      if (
        !createHash('sha256')
          .update(payload)
          .digest()
          .equals(header.subarray(4))
      )
        throw new Error('recording_corrupt_tail');
      const value = JSON.parse(payload.toString('utf8')) as JournalRecord;
      if (
        !value ||
        !/^\d+$/.test(value.ordinal) ||
        typeof value.kind !== 'string' ||
        typeof value.recorded_at !== 'string' ||
        !value.data ||
        typeof value.data !== 'object'
      )
        throw new Error('recording_invalid_record');
      yield value;
    }
  } finally {
    await handle.close();
  }
}

/** Single bounded append/sync owner, with persistent identity checked on every reopen. */
export class RecordingJournal {
  readonly directory: string;
  readonly id: string;
  readonly sessionId: string;
  private seal: (segment: JournalSegment, bytes: Uint8Array) => Promise<void>;
  private faults: RecordingFaults;
  private reserve: (bytes: number) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private pendingBytes = 0;
  private ordinal = 0n;
  private baseIndex = 0;
  private segments: JournalSegment[] = [];
  private adopted = new Set<string>();
  private current?: JournalSegment;
  private handle?: Awaited<ReturnType<typeof open>>;
  private lastSeal = performance.now();
  private closed = false;
  private deadlineMillis: number;
  corruptReason?: string;
  constructor(
    directory: string,
    id: string,
    sessionId: string,
    seal: (segment: JournalSegment, bytes: Uint8Array) => Promise<void>,
    faults: RecordingFaults = {},
    reserve: (bytes: number) => Promise<void> = async () => {},
    deadlineMillis = 1000,
  ) {
    this.id = id;
    this.sessionId = sessionId;
    this.seal = seal;
    this.faults = faults;
    this.reserve = reserve;
    this.deadlineMillis = deadlineMillis;
    if (!uuid.test(id) || !uuid.test(sessionId))
      throw new Error('recording_invalid_owner');
    this.directory = join(directory, 'recordings', id);
  }
  async initialize(
    published: Array<{ index: number; last_ordinal: string }> = [],
  ) {
    const parent = join(this.directory, '..');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
      throw new Error('recording_owned_directory_changed');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('recording_owned_directory_changed');
    const owner = {
      format: 'lab-word-recording-v1',
      recording_id: this.id,
      session_id: this.sessionId,
    };
    const ownerPath = join(this.directory, 'owner.json');
    try {
      const previous = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(owner))
        throw new Error('recording_owner_changed');
      if ((await lstat(ownerPath)).isSymbolicLink())
        throw new Error('recording_owner_changed');
    } catch (error) {
      if (!absent(error)) throw error;
      const ownerHandle = await open(ownerPath, 'wx', 0o600);
      try {
        await ownerHandle.writeFile(JSON.stringify(owner));
        await ownerHandle.sync();
      } finally {
        await ownerHandle.close();
      }
      await this.syncDirectory();
    }
    const names = (await readdir(this.directory))
      .filter((n) => segmentName.test(n))
      .sort();
    if (names.length > 1024) throw new Error('recording_segment_capacity');
    const firstIndex = names.length
      ? Number(segmentName.exec(names[0])![1])
      : Infinity;
    const base = published.filter((p) => p.index < firstIndex).at(-1);
    if (base) {
      this.ordinal = BigInt(base.last_ordinal);
      this.baseIndex = base.index + 1;
    }
    let broken = false;
    for (const name of names) {
      const match = segmentName.exec(name)!,
        path = join(this.directory, name);
      const part: JournalSegment = {
        id: match[2],
        index: Number(match[1]),
        size: 0,
        sha256: '',
        first_ordinal: '0',
        last_ordinal: '0',
        sealed: true,
        path,
      };
      if (broken) break;
      try {
        for await (const record of readJournal(path)) {
          if (BigInt(record.ordinal) !== this.ordinal + 1n)
            throw new Error('recording_ordinal_gap');
          if (!part.size) part.first_ordinal = record.ordinal;
          part.size += encodeJournalRecord(record).length;
          part.last_ordinal = record.ordinal;
          this.ordinal = BigInt(record.ordinal);
        }
      } catch (error) {
        broken = true;
        this.corruptReason =
          error instanceof Error ? error.message : 'recording_corrupt_tail';
        if (name !== names.at(-1))
          throw new Error('recording_corrupt_sealed_segment', { cause: error });
        const damaged = await readFile(path);
        const tail = damaged.subarray(part.size);
        if (tail.length) {
          await this.reserve(tail.length);
          const evidence = await open(
            join(this.directory, `quarantine-${randomUUID()}.bin`),
            'wx',
            0o600,
          );
          try {
            await evidence.writeFile(tail);
            await evidence.sync();
          } finally {
            await evidence.close();
          }
        }
        const repair = await open(path, 'r+');
        try {
          await repair.truncate(part.size);
          await repair.sync();
        } finally {
          await repair.close();
        }
        await this.syncDirectory();
      }
      if (part.size) {
        const bytes = await readFile(path);
        part.sha256 = journalDigest(bytes.subarray(0, part.size));
        this.segments.push(part);
      } else {
        // A verified empty/torn last candidate owns no confirmed ordinal. Its
        // damaged bytes already have quarantine custody; do not leave a second
        // filename at the next segment index when writing resumes.
        await rm(path);
        await this.syncDirectory();
      }
    }
  }
  private async syncDirectory() {
    if (process.platform === 'win32') return;
    const h = await open(this.directory, 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  }
  private enqueue<T>(bytes: number, work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('recording_closed'));
    if (this.pendingCount >= 256 || this.pendingBytes + bytes > 8 * 1024 * 1024)
      return Promise.reject(new Error('recording_ingress_capacity'));
    this.pendingCount++;
    this.pendingBytes += bytes;
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result.finally(() => {
      this.pendingCount--;
      this.pendingBytes -= bytes;
    });
  }
  private async begin() {
    if (this.current) return;
    const index = this.segments.length
      ? this.segments.at(-1)!.index + 1
      : this.baseIndex;
    if (index >= 1024) throw new Error('recording_segment_capacity');
    const id = randomUUID(),
      path = join(
        this.directory,
        `${String(index).padStart(6, '0')}-${id}.lwf`,
      );
    this.handle = await open(path, 'wx', 0o600);
    this.current = {
      id,
      index,
      size: 0,
      sha256: '',
      first_ordinal: String(this.ordinal + 1n),
      last_ordinal: String(this.ordinal),
      sealed: false,
      path,
    };
    await this.syncDirectory();
  }
  async append(
    kind: string,
    data: Record<string, unknown>,
    recordedAt: string,
  ) {
    const estimated = Buffer.byteLength(JSON.stringify(data)) + 256;
    return this.enqueue(estimated, async () => {
      await this.begin();
      const record: JournalRecord = {
        ordinal: String(this.ordinal + 1n),
        kind,
        recorded_at: recordedAt,
        data,
      };
      const bytes = encodeJournalRecord(record);
      if (
        this.current!.size &&
        this.current!.size + bytes.length > 1024 * 1024
      ) {
        await this.sealCurrent();
        await this.begin();
      }
      await this.reserve(bytes.length);
      const before = this.current!.size;
      try {
        await waitRecordingFault(
          this.faults.beforeWrite?.(this.id, kind),
          this.deadlineMillis,
        );
        let done = 0;
        while (done < bytes.length) {
          const written = (
            await this.handle!.write(
              bytes,
              done,
              bytes.length - done,
              before + done,
            )
          ).bytesWritten;
          if (!written) throw new Error('recording_short_write');
          done += written;
        }
        await waitRecordingFault(
          this.faults.beforeSync?.(this.id, kind),
          this.deadlineMillis,
        );
        await this.handle!.sync();
      } catch (error) {
        await this.handle!.truncate(before);
        await this.handle!.sync();
        throw error;
      }
      this.ordinal++;
      this.current!.last_ordinal = String(this.ordinal);
      this.current!.size += bytes.length;
      if (performance.now() - this.lastSeal >= 5000) await this.sealCurrent();
      return record;
    });
  }
  private async sealCurrent() {
    const current = this.current;
    if (!current?.size) return;
    await this.handle!.sync();
    await this.handle!.close();
    this.handle = undefined;
    this.current = undefined;
    const bytes = await readFile(current.path);
    current.sha256 = journalDigest(bytes);
    current.sealed = true;
    this.segments.push(current);
    await this.seal(current, bytes);
    this.adopted.add(current.id);
    this.lastSeal = performance.now();
  }
  async sealAll() {
    return this.enqueue(0, async () => {
      await this.sealCurrent();
      for (const part of this.segments) {
        if (this.adopted.has(part.id)) continue;
        const bytes = await readFile(part.path);
        if (
          bytes.length < part.size ||
          journalDigest(bytes.subarray(0, part.size)) !== part.sha256
        )
          throw new Error('recording_seal_changed');
        await this.seal(part, bytes.subarray(0, part.size));
        this.adopted.add(part.id);
      }
    });
  }
  async barrier() {
    const admitted = this.tail;
    await admitted;
  }
  async inventory() {
    await this.barrier();
    return [
      ...this.segments,
      ...(this.current?.size ? [this.current] : []),
    ].map((p) => ({ ...p }));
  }
  async *records() {
    const parts = await this.inventory();
    for (const part of parts) yield* readJournal(part.path, part.size);
  }
  async close() {
    this.closed = true;
    await this.barrier();
    await this.handle?.close();
    this.handle = undefined;
  }
  async remove() {
    await this.close();
    const owner = JSON.parse(
      await readFile(join(this.directory, 'owner.json'), 'utf8'),
    );
    if (owner.recording_id !== this.id || owner.session_id !== this.sessionId)
      throw new Error('recording_owner_changed');
    for (const name of await readdir(this.directory)) {
      if (
        name !== 'owner.json' &&
        !segmentName.test(name) &&
        !quarantineName.test(name)
      )
        throw new Error('recording_unknown_owned_file');
      const stat = await lstat(join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('recording_owned_file_changed');
    }
    await rm(this.directory, { recursive: true });
  }
}
