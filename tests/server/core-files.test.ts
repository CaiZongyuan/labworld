import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../../apps/server/src/runtime.ts';
import { createHash } from 'node:crypto';
import { rename, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Database, sql } from '../../packages/server/src/platform/db/index.ts';
import { BlobMissing } from '../../packages/server/src/platform/blob-store.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';
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
  let planCount = 0;
  let planned!: () => void;
  const plans = new Promise<void>((resolve) => {
    planned = resolve;
  });
  const db = new Database(undefined, (measurement) => {
    if (
      ['race-first', 'race-second'].includes(measurement.id) &&
      measurement.commands.length === 1 &&
      ++planCount === 2
    )
      planned();
  });
  const policy = { ...configuration().auth, origin: owned.url };
  let now = Date.now();
  const context = { db, clock: { now: () => new Date(now).toISOString() } };
  let server: ReturnType<typeof serve> | undefined;
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
  try {
    await owned.startInProcess(
      'Core file HTTP and embedded DB',
      async () => {
        await db.initialize();
        await service.initialize();
        fileRoutes(app, service);
        server = serve({
          fetch: app.fetch,
          hostname: '127.0.0.1',
          port: owned.port,
        });
      },
      async () => {
        if (server) {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
          server = undefined;
        }
        await db.close();
      },
    );
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
    const deniedHead = await fetch(download.url, { method: 'HEAD' });
    assert.equal(deniedHead.status, 403);
    const afterHead = await fetch(download.url);
    assert.equal(afterHead.status, 200);
    assert.deepEqual(Buffer.from(await afterHead.arrayBuffer()), bytes);
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
    // Necessary ownership supplement: this consumer is test-owned, not a seeded Lab.
    await db.script(
      { id: 'unknown-fk-consumer', kind: 'startup' },
      'create schema file_proof; create table file_proof.references(file_id uuid primary key references labos_threejs_core.files(id))',
    );
    await db.transaction(
      { id: 'unknown-fk-reference', kind: 'request' },
      async (tx) => {
        await tx.execute(
          sql`insert into file_proof.references(file_id) values(${ready.id}::uuid)`,
        );
        await service.release(tx, ready.id, {
          ownerType: 'owned-file-capability',
          ownerId: 'first',
        });
      },
    );
    await assert.rejects(
      db.transaction({ id: 'unknown-fk-dispose', kind: 'request' }, (tx) =>
        service.dispose(tx, ready.id),
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'files.in_use',
    );
    now += defaultFilePolicy.uploadSecs * 1000 + 1;
    assert.deepEqual((await service.cleanup('unknown-fk-cleanup')).retained, [
      ready.id,
    ]);
    const foreignDownload = await db.transaction(
      { id: 'unknown-fk-download', kind: 'request' },
      (tx) => service.download(tx, actor, ready.id),
    );
    const foreignBytes = await fetch(foreignDownload.url);
    assert.equal(foreignBytes.status, 200);
    assert.deepEqual(Buffer.from(await foreignBytes.arrayBuffer()), bytes);
    await db.transaction({ id: 'unknown-fk-release', kind: 'request' }, (tx) =>
      tx.execute(
        sql`delete from file_proof.references where file_id=${ready.id}::uuid`,
      ),
    );
    now += 300001; // Referenced files are reconsidered after the bounded cleanup defer interval.
    assert.deepEqual((await service.cleanup('unreferenced-cleanup')).deleted, [
      ready.id,
    ]);
    await assert.rejects(
      service.blobs.inspect(
        `objects/${ready.sha256.slice(0, 2)}/${ready.sha256}`,
        defaultFilePolicy.maxBytes,
      ),
      BlobMissing,
    );
    const raceBytes = Buffer.from('concurrent completion\n');
    const raceHash = createHash('sha256').update(raceBytes).digest('hex');
    const race = await db.transaction(
      { id: 'race-start', kind: 'request' },
      (tx) =>
        service.start(tx, actor, {
          file_name: 'race.txt',
          content_type: 'text/plain',
          size: raceBytes.length,
          sha256: raceHash,
        }),
    );
    const raceUploaded = await fetch(race.upload!.url, {
      method: 'PUT',
      headers: race.upload!.headers,
      body: raceBytes,
    });
    assert.equal(raceUploaded.status, 204);
    await raceUploaded.arrayBuffer();
    let release!: () => void, entered!: () => void;
    const enter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = service.blobs.withHash(raceHash, async () => {
      entered();
      await hold;
    });
    await enter;
    const publish = async (
      tx: Parameters<FileService['pin']>[0],
      file: { id: string },
    ) => {
      await service.pin(tx, file.id, {
        ownerType: 'owned-file-capability',
        ownerId: 'race',
      });
      return file;
    };
    const first = service.complete(
      actor,
      race.upload_id,
      'race-first',
      publish,
    );
    const last = service.complete(
      actor,
      race.upload_id,
      'race-second',
      publish,
    );
    await plans;
    release();
    await gate;
    assert.equal((await first).id, (await last).id);
    const audit = await client.json<{ data: unknown[] }>(
      'GET',
      `/api/v1/audit-events?action=files.complete&resource_id=${race.upload_id}`,
    );
    assert.equal(audit.data.length, 1);
    const pending = await db.transaction(
      { id: 'fault-upload-start', kind: 'request' },
      (tx) =>
        service.start(tx, actor, {
          file_name: 'pending.txt',
          content_type: 'text/plain',
          size: raceBytes.length,
          sha256: raceHash,
        }),
    );
    const wrong = await fetch(pending.upload!.url, {
      method: 'PUT',
      headers: pending.upload!.headers,
      body: Buffer.from('incorrect checksum'),
    });
    assert.equal(wrong.status, 400);
    await wrong.arrayBuffer();
    const raceDownload = await db.transaction(
      { id: 'fault-download-start', kind: 'request' },
      (tx) => service.download(tx, actor, race.upload_id),
    );
    await db.script(
      { id: 'file-read-fault', kind: 'startup' },
      'alter table labos_threejs_core.files rename to files_unavailable',
    );
    for (const [url, method] of [
      [pending.upload!.url, 'PUT'],
      [raceDownload.url, 'GET'],
    ] as const) {
      const failed = await fetch(url, {
        method,
        ...(method === 'PUT'
          ? { headers: pending.upload!.headers, body: raceBytes }
          : {}),
      });
      assert.equal(failed.status, 503);
      const error = await failed.json();
      assert.equal(error.error.code, 'files.unavailable');
      assert.equal(error.error.request_id, failed.headers.get('x-request-id'));
    }
    await db.script(
      { id: 'file-read-recover', kind: 'startup' },
      'alter table labos_threejs_core.files_unavailable rename to files',
    );
    const recovered = await fetch(pending.upload!.url, {
      method: 'PUT',
      headers: pending.upload!.headers,
      body: raceBytes,
    });
    assert.equal(recovered.status, 204);
    await recovered.arrayBuffer();
    const healthy = await fetch(raceDownload.url);
    assert.equal(healthy.status, 200);
    assert.deepEqual(Buffer.from(await healthy.arrayBuffer()), raceBytes);
    for (const [content_type, bytes, previewable] of [
      ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), true],
      ['application/pdf', Buffer.from('%PDF-1.7\n'), false],
      ['image/svg+xml', Buffer.from('<svg/>'), false],
    ] as const) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const upload = await db.transaction(
        { id: 'preview-start', kind: 'request' },
        (tx) =>
          service.start(tx, actor, {
            file_name: 'preview',
            content_type,
            size: bytes.length,
            sha256,
          }),
      );
      const put = await fetch(upload.upload!.url, {
        method: 'PUT',
        headers: upload.upload!.headers,
        body: bytes,
      });
      assert.equal(put.status, 204);
      await put.arrayBuffer();
      const metadata = await service.complete(
        actor,
        upload.upload_id,
        'preview-complete',
        async (_tx, file) => file,
      );
      assert.equal(metadata.previewable, previewable, content_type);
      await db.transaction({ id: 'preview-dispose', kind: 'request' }, (tx) =>
        service.dispose(tx, metadata.id),
      );
      assert.equal(
        (await service.cleanup('preview-cleanup')).deleted.includes(
          metadata.id,
        ),
        true,
      );
    }
    const missing = await db.transaction(
      { id: 'no-put-start', kind: 'request' },
      (tx) =>
        service.start(tx, actor, {
          file_name: 'no-put.txt',
          content_type: 'text/plain',
          size: 7,
          sha256: createHash('sha256').update('missing').digest('hex'),
        }),
    );
    now += defaultFilePolicy.uploadSecs * 1000 + 1;
    assert.equal(
      (await service.cleanup('no-put-expired')).deleted.includes(
        missing.upload_id,
      ),
      true,
    );
    const faultBytes = Buffer.from('recoverable retirement bytes');
    const faultHash = createHash('sha256').update(faultBytes).digest('hex');
    const fault = await db.transaction(
      { id: 'retire-start', kind: 'request' },
      (tx) =>
        service.start(tx, actor, {
          file_name: 'retire.txt',
          content_type: 'text/plain',
          size: faultBytes.length,
          sha256: faultHash,
        }),
    );
    const put = await fetch(fault.upload!.url, {
      method: 'PUT',
      headers: fault.upload!.headers,
      body: faultBytes,
    });
    assert.equal(put.status, 204);
    await put.arrayBuffer();
    await service.complete(
      actor,
      fault.upload_id,
      'retire-complete',
      async (_tx, file) => file,
    );
    await db.transaction({ id: 'retire-dispose', kind: 'request' }, (tx) =>
      service.dispose(tx, fault.upload_id),
    );
    const physical = join(
      service.blobs.directory,
      'objects',
      faultHash.slice(0, 2),
      faultHash,
    );
    const saved = join(
      service.blobs.directory,
      'temporary',
      'owned-retirement-fault',
    );
    await rename(physical, saved);
    await mkdir(physical);
    await assert.rejects(service.cleanup('retire-io-fault'));
    assert.equal(
      (
        await db.read({ id: 'retire-pending-intent', kind: 'request' }, (tx) =>
          service.load(tx, fault.upload_id),
        )
      ).state,
      'deleting',
    );
    await rmdir(physical);
    await rename(saved, physical);
    assert.equal(
      (await service.cleanup('retire-recover')).deleted.includes(
        fault.upload_id,
      ),
      true,
    );
    assert.deepEqual((await service.cleanup('retire-repeat')).deleted, []);
    await assert.rejects(
      service.blobs.inspect(
        `objects/${faultHash.slice(0, 2)}/${faultHash}`,
        defaultFilePolicy.maxBytes,
      ),
      BlobMissing,
    );
    const retainedBytes = Buffer.from('bounded cleanup bytes');
    const retainedHash = createHash('sha256')
      .update(retainedBytes)
      .digest('hex');
    for (let index = 0; index < 51; index++) {
      const cap = await db.transaction(
        { id: 'bounded-retained-start', kind: 'request' },
        (tx) =>
          service.start(tx, actor, {
            file_name: `retained-${index}`,
            content_type: 'text/plain',
            size: retainedBytes.length,
            sha256: retainedHash,
          }),
      );
      const uploaded = await fetch(cap.upload!.url, {
        method: 'PUT',
        headers: cap.upload!.headers,
        body: retainedBytes,
      });
      assert.equal(uploaded.status, 204);
      await uploaded.arrayBuffer();
      await service.complete(
        actor,
        cap.upload_id,
        'bounded-retained-ready',
        async (tx, file) => {
          await service.pin(tx, file.id, {
            ownerType: 'owned-file-capability',
            ownerId: `bounded-${index}`,
          });
          return file;
        },
      );
    }
    const behind = await db.transaction(
      { id: 'bounded-disposable-start', kind: 'request' },
      (tx) =>
        service.start(tx, actor, {
          file_name: 'after-retained',
          content_type: 'text/plain',
          size: 7,
          sha256: createHash('sha256').update('bounded').digest('hex'),
        }),
    );
    now += defaultFilePolicy.uploadSecs * 1000 + 1;
    assert.equal(
      (await service.cleanup('bounded-cleanup-first')).deleted.includes(
        behind.upload_id,
      ),
      false,
    );
    assert.equal(
      (await service.cleanup('bounded-cleanup-next')).deleted.includes(
        behind.upload_id,
      ),
      true,
    );
    const orphanBytes = Buffer.from(
      'owned orphan after interrupted publication',
    );
    const orphan = await service.blobs.stage(
      (async function* () {
        yield orphanBytes;
      })(),
      defaultFilePolicy.maxBytes,
    );
    const orphanObject = await service.blobs.withHash(orphan.sha256, () =>
      service.blobs.adopt(orphan.key, orphan.sha256),
    );
    const rescanned = await service.rescan('orphan-rescan');
    assert.equal(rescanned.removed.includes(orphan.key), true);
    assert.equal(rescanned.removed.includes(orphanObject), true);
    await assert.rejects(
      service.blobs.inspect(orphanObject, defaultFilePolicy.maxBytes),
      BlobMissing,
    );
    assert.equal(
      (
        await service.blobs.inspect(
          `objects/${retainedHash.slice(0, 2)}/${retainedHash}`,
          defaultFilePolicy.maxBytes,
        )
      ).sha256,
      retainedHash,
    );
  } finally {
    await owned.cleanup();
  }
});
