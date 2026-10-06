import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../../apps/server/src/runtime.ts';
import { createHash } from 'node:crypto';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';
import { defaultFilePolicy } from '../../packages/server/src/core/files/domain.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { fileRoutes } from '../../packages/server/src/core/files/routes.ts';
import { requireAccess } from '../../packages/server/src/core/api-keys/authentication.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

test('real FileService returns a signed HTTP upload and publishes verified immutable bytes in the caller transaction', async () => {
  const owned = await new ServerProcess().create();
  const db = new Database();
  const policy = { ...configuration().auth, origin: owned.url };
  const context = { db, clock: { now: () => new Date().toISOString() } };
  let server: ReturnType<typeof serve> | undefined;
  try {
    await db.initialize();
    const app = coreApp(context, 'test', policy, () => {}, {
      ...defaultRateOptions,
      enabled: false,
    });
    const service = new FileService(
      context,
      defaultFilePolicy,
      policy,
      owned.url,
      owned.directory,
    );
    await service.initialize();
    fileRoutes(app, service);
    server = serve({
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: owned.port,
    });
    const client = new CoreHttp(owned.url);
    await client.register('files@example.test');
    const headers = new Headers({
      cookie: client.cookie!,
      origin: owned.url,
      'x-csrf-token': client.session!.csrf_token,
    });
    const actor = await requireAccess(
      context,
      policy,
      headers,
      'file-begin',
      'lab:full',
      true,
    );
    const bytes = Buffer.from('immutable file bytes\n');
    const capability = await db.transaction(
      { id: 'file-start', kind: 'request' },
      (tx) =>
        service.start(tx, actor, {
          file_name: 'sample.txt',
          content_type: 'text/plain',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
    );
    assert.equal(capability.upload!.method, 'PUT');
    const uploaded = await fetch(capability.upload!.url, {
      method: 'PUT',
      headers: capability.upload!.headers,
      body: bytes,
    });
    assert.equal(uploaded.status, 204);
    await uploaded.arrayBuffer();
    const ready = await service.complete(
      actor,
      capability.upload_id,
      'file-publish',
      async (tx, file) => {
        await service.pin(tx, file.id, {
          ownerType: 'owned-file-capability',
          ownerId: 'first',
        });
        return file;
      },
    );
    assert.equal(ready.size, bytes.length);
    assert.equal(
      ready.sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    const download = await db.transaction(
      { id: 'file-download', kind: 'request' },
      (tx) => service.download(tx, actor, ready.id),
    );
    const response = await fetch(download.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const second = await db.transaction(
      { id: 'same-hash-start', kind: 'request' },
      (tx) =>
        service.start(tx, actor, {
          file_name: 'second.txt',
          content_type: 'text/plain',
          size: bytes.length,
          sha256: ready.sha256,
        }),
    );
    const secondUploaded = await fetch(second.upload!.url, {
      method: 'PUT',
      headers: second.upload!.headers,
      body: bytes,
    });
    assert.equal(secondUploaded.status, 204);
    await secondUploaded.arrayBuffer();
    const other = await service.complete(
      actor,
      second.upload_id,
      'same-hash-publish',
      async (_tx, file) => file,
    );
    assert.notEqual(other.id, ready.id);
    await db.transaction({ id: 'dispose-unpinned', kind: 'request' }, (tx) =>
      service.dispose(tx, other.id),
    );
    assert.deepEqual((await service.cleanup('same-hash-cleanup')).deleted, [
      other.id,
    ]);
    const retained = await fetch(download.url);
    assert.equal(retained.status, 200);
    assert.deepEqual(Buffer.from(await retained.arrayBuffer()), bytes);
  } finally {
    if (server) {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await db.close();
    await owned.cleanup();
  }
});
