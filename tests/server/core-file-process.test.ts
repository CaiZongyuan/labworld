import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import type {
  UploadCapability,
  FileInfo,
  DownloadCapability,
} from '../../packages/server/src/core/files/domain.ts';
function capability<T>(
  target: ServerProcess,
  command: string,
  headers: Record<string, string>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const child = target.child!,
    id = randomUUID();
  return new Promise((resolve, reject) => {
    const clear = () => {
      child.off('message', receive);
      child.off('exit', exited);
    };
    const receive = (message: unknown) => {
      const value = message as { id: string; result: T; error?: unknown };
      if (value.id !== id) return;
      clear();
      if (value.error) reject(value.error);
      else resolve(value.result);
    };
    const exited = () => {
      clear();
      reject(new Error('Owned process exited before capability response'));
    };
    child.on('message', receive);
    child.once('exit', exited);
    child.send({ id, command, headers, ...fields }, (error) => {
      if (error) {
        clear();
        reject(error);
      }
    });
  });
}
test(
  'actual FileService process kill preserves published signed bytes and rolls uncommitted ready pin audit back; rescan removes the orphan',
  { timeout: 60000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'tests/support/files-process.ts';
    target.ipc = true;
    target.env = { APP_ORIGIN: target.url, UPLOAD_SESSION_SECS: '1' };
    const bytes = Buffer.from('confirmed immutable process bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      await target.start();
      const client = new CoreHttp(target.url);
      await client.register('process-file@example.test');
      const headers = {
        cookie: client.cookie!,
        origin: target.url,
        'x-csrf-token': client.csrf!,
      };
      const start = () =>
        capability<UploadCapability>(target, 'start', headers, {
          input: {
            file_name: 'process.txt',
            content_type: 'text/plain',
            size: bytes.length,
            sha256,
          },
        });
      const put = async (cap: UploadCapability) => {
        const response = await fetch(cap.upload!.url, {
          method: 'PUT',
          headers: cap.upload!.headers,
          body: bytes,
        });
        assert.equal(response.status, 204);
        await response.arrayBuffer();
      };
      const published = await start();
      await put(published);
      const ready = await capability<FileInfo>(target, 'complete', headers, {
        fileId: published.upload_id,
      });
      const signed = await capability<DownloadCapability>(
        target,
        'download',
        headers,
        { fileId: ready.id },
      );
      await target.stop('SIGKILL');
      await target.start();
      const persisted = await fetch(signed.url);
      assert.equal(persisted.status, 200);
      assert.deepEqual(Buffer.from(await persisted.arrayBuffer()), bytes);
      const orphanBytes = Buffer.from('crash before publication commit');
      const orphanHash = createHash('sha256').update(orphanBytes).digest('hex');
      const pending = await capability<UploadCapability>(
        target,
        'start',
        headers,
        {
          input: {
            file_name: 'orphan.txt',
            content_type: 'text/plain',
            size: orphanBytes.length,
            sha256: orphanHash,
          },
        },
      );
      const upload = await fetch(pending.upload!.url, {
        method: 'PUT',
        headers: pending.upload!.headers,
        body: orphanBytes,
      });
      assert.equal(upload.status, 204);
      await upload.arrayBuffer();
      const crashed = capability(target, 'crash_complete', headers, {
        fileId: pending.upload_id,
      });
      crashed.catch(() => {});
      await once(target.child!, 'exit');
      await assert.rejects(crashed, /exited before capability response/);
      await target.stop();
      await target.start();
      assert.equal(
        (
          await capability<{ state: string }>(target, 'load', headers, {
            fileId: pending.upload_id,
          })
        ).state,
        'pending_upload',
      );
      const audit = await client.json<{ data: unknown[] }>(
        'GET',
        `/api/v1/audit-events?action=files.complete&resource_id=${pending.upload_id}`,
      );
      assert.deepEqual(audit.data, []);
      await until(
        async () => Date.now(),
        (now) => now > Date.parse(pending.upload!.expires_at) + 1000,
        5000,
      );
      const scan = await capability<{ removed: string[] }>(
        target,
        'rescan',
        headers,
      );
      assert.equal(
        scan.removed.includes(
          `objects/${orphanHash.slice(0, 2)}/${orphanHash}`,
        ),
        true,
        JSON.stringify(scan),
      );
      const still = await fetch(signed.url);
      assert.equal(still.status, 200);
      assert.deepEqual(Buffer.from(await still.arrayBuffer()), bytes);
    } finally {
      await target.cleanup();
    }
  },
);

test(
  'real shutdown drains file maintenance waiting on an unfinished upload without requiring force kill',
  { timeout: 30000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'tests/support/files-process.ts';
    target.ipc = true;
    target.env = {
      APP_ORIGIN: target.url,
      UPLOAD_SESSION_SECS: '1',
      OWNED_FILE_SCHEDULER_MS: '100',
    };
    const abort = new AbortController();
    const bytes = Buffer.from('unfinished owned upload');
    try {
      await target.start();
      const client = new CoreHttp(target.url);
      await client.register('shutdown-file@example.test');
      const headers = {
        cookie: client.cookie!,
        origin: target.url,
        'x-csrf-token': client.csrf!,
      };
      const cap = await capability<UploadCapability>(target, 'start', headers, {
        input: {
          file_name: 'unfinished.txt',
          content_type: 'text/plain',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 4));
        },
      });
      const uploading = fetch(cap.upload!.url, {
        method: 'PUT',
        headers: cap.upload!.headers,
        body,
        signal: abort.signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      uploading.catch(() => {});
      await until(
        () =>
          capability<{ state: string }>(target, 'load', headers, {
            fileId: cap.upload_id,
          }),
        (file) => file.state === 'deleting',
        8000,
      );
      const child = target.child!;
      await target.stop();
      assert.equal(
        child.signalCode,
        null,
        'Graceful shutdown must finish before the fixture force-kill deadline',
      );
      assert.equal(child.exitCode, 0);
    } finally {
      abort.abort();
      await target.cleanup();
    }
  },
);
