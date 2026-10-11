import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { LocalBlobStore } from '../../packages/server/src/platform/blob-store.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';
import {
  eventWindow,
  type EventPart,
} from '../../packages/server/src/lab/recordings/event-window.ts';
import {
  encodeJournalRecord,
  decodeJournalBytes,
} from '../../packages/server/src/lab/recordings/journal.ts';

const id = '10000000-0000-0000-0000-000000000001';
const operation = { id: 'owned-managed-read-bound', kind: 'request' } as const;
const maximumBytes = 1024 * 1024;
async function fixture(bytes: Buffer, metadataSize = bytes.length) {
  const root = await mkdtemp(join(tmpdir(), 'managed-read-bound-owned-'));
  try {
    const sha256 = createHash('sha256').update(bytes).digest();
    const key = `objects/${sha256.toString('hex').slice(0, 2)}/${sha256.toString('hex')}`;
    const path = join(root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const row = {
      state: 'ready',
      readyKey: key,
      actualSize: metadataSize,
      sha256,
    };
    // Exercise the actual managedBytes and load methods without an app or database.
    const service = Object.create(FileService.prototype) as FileService;
    service.context = {
      db: {
        read: async (_operation: unknown, work: (tx: unknown) => unknown) =>
          work({ select: () => ({ from: () => ({ where: () => [row] }) }) }),
      },
    } as unknown as FileService['context'];
    service.blobs = new LocalBlobStore(root);
    let inspecting = false;
    const counts = { inspections: 0, hashReadBytes: 0, streamReadBytes: 0 };
    const inspect = service.blobs.inspect.bind(service.blobs);
    service.blobs.inspect = async (...args) => {
      counts.inspections++;
      inspecting = true;
      try {
        return await inspect(...args);
      } finally {
        inspecting = false;
      }
    };
    const read = service.blobs.read.bind(service.blobs);
    service.blobs.read = async function* (...args) {
      for await (const chunk of read(...args)) {
        if (inspecting) counts.hashReadBytes += chunk.length;
        else counts.streamReadBytes += chunk.length;
        yield chunk;
      }
    };
    return {
      service,
      row,
      path,
      counts,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
async function collect(bytes: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of bytes) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const unavailable = (error: unknown) =>
  error instanceof PublicFailure && error.code === 'files.unavailable';

test('caller metadata mismatch and oversize reject before actual blob inspection', async () => {
  const f = await fixture(Buffer.alloc(2 * maximumBytes, 1));
  try {
    for (const expectedSize of [128 * 1024, 2 * maximumBytes])
      await assert.rejects(
        f.service.managedBytes(id, operation, { expectedSize, maximumBytes }),
        unavailable,
      );
    assert.deepEqual(f.counts, {
      inspections: 0,
      hashReadBytes: 0,
      streamReadBytes: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('larger physical blob rejects before reading payload despite bounded Core metadata', async () => {
  const f = await fixture(Buffer.alloc(2 * maximumBytes, 1), 128 * 1024);
  try {
    await assert.rejects(
      f.service.managedBytes(id, operation, {
        expectedSize: f.row.actualSize,
        maximumBytes,
      }),
      /Stored content size changed/,
    );
    assert.deepEqual(f.counts, {
      inspections: 1,
      hashReadBytes: 0,
      streamReadBytes: 0,
    });
  } finally {
    await f.cleanup();
  }
});

test('normal bounded and legacy managed reads verify real size and checksum', async () => {
  const bytes = Buffer.alloc(32 * 1024, 7);
  const f = await fixture(bytes);
  try {
    for (const bounds of [
      { expectedSize: bytes.length, maximumBytes },
      undefined,
    ]) {
      assert.deepEqual(
        await collect(await f.service.managedBytes(id, operation, bounds)),
        bytes,
      );
    }
    assert.equal(f.counts.hashReadBytes, 2 * bytes.length);
    assert.equal(f.counts.streamReadBytes, 2 * bytes.length);
    const corrupt = Buffer.from(bytes);
    corrupt[0] ^= 1;
    await writeFile(f.path, corrupt);
    await assert.rejects(
      f.service.managedBytes(id, operation, {
        expectedSize: bytes.length,
        maximumBytes,
      }),
      unavailable,
    );
    assert.equal(f.counts.hashReadBytes, 3 * bytes.length);
    await writeFile(f.path, bytes.subarray(0, bytes.length - 1));
    await assert.rejects(
      f.service.managedBytes(id, operation, {
        expectedSize: bytes.length,
        maximumBytes,
      }),
      /Stored content size changed/,
    );
    assert.equal(f.counts.hashReadBytes, 3 * bytes.length);
  } finally {
    await f.cleanup();
  }
});

test('growth after stat cannot add an extra chunk beyond the exact read bound', async () => {
  const bytes = Buffer.alloc(128 * 1024, 7);
  const f = await fixture(bytes);
  try {
    const stream = await f.service.managedBytes(id, operation, {
      expectedSize: bytes.length,
      maximumBytes,
    });
    let appended = false;
    let bytesRead = 0;
    await assert.rejects(async () => {
      for await (const chunk of stream) {
        bytesRead += chunk.length;
        if (!appended) {
          appended = true;
          await appendFile(f.path, Buffer.alloc(2 * maximumBytes));
        }
      }
    }, /Stored content size changed/);
    assert.equal(appended, true);
    assert.equal(bytesRead, bytes.length);
    assert.equal(f.counts.hashReadBytes, bytes.length);
    assert.equal(f.counts.streamReadBytes, bytes.length);
  } finally {
    await f.cleanup();
  }
});

test('bounded verified files still supply the scan and two exact legacy points', async () => {
  const owned: Awaited<ReturnType<typeof fixture>>[] = [];
  try {
    for (let ordinal = 1; ordinal <= 3; ordinal++)
      owned.push(
        await fixture(
          encodeJournalRecord({
            ordinal: String(ordinal),
            kind: 'header',
            recorded_at: 'now',
            data: { padding: 'a'.repeat(32 * 1024) },
          }),
        ),
      );
    const parts: EventPart[] = owned.map((f, index) => ({
      id: String(index),
      index,
      size: f.row.actualSize,
      first_ordinal: String(index + 1),
      last_ordinal: String(index + 1),
      file_id: id,
      path: null,
    }));
    const window = await eventWindow('1', parts, async (part) =>
      decodeJournalBytes(
        await collect(
          await owned[part.index].service.managedBytes(id, operation, {
            expectedSize: part.size,
            maximumBytes,
          }),
        ),
      ),
    );
    assert.deepEqual(
      window.records.map((r) => r.ordinal),
      ['2'],
    );
    assert.equal((await window.at('1'))?.ordinal, '1');
    assert.equal((await window.at('3'))?.ordinal, '3');
    for (const f of owned) {
      assert.equal(f.counts.inspections, 1);
      assert.equal(f.counts.hashReadBytes, f.row.actualSize);
      assert.equal(f.counts.streamReadBytes, f.row.actualSize);
    }
  } finally {
    await Promise.all(owned.map((f) => f.cleanup()));
  }
});
