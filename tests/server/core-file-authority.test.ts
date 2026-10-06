import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { serve } from '../../apps/server/src/runtime.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { fileRoutes } from '../../packages/server/src/core/files/routes.ts';
import {
  defaultFilePolicy,
  type FilePolicy,
} from '../../packages/server/src/core/files/domain.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';
import {
  requireAccess,
  type AccessActor,
} from '../../packages/server/src/core/api-keys/authentication.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import type {
  CreatedApiKey,
  AuditPage,
} from '../../packages/contracts/src/generated/types.gen.ts';
async function fixture(filePolicy: FilePolicy = defaultFilePolicy) {
  const owned = await new ServerProcess().create();
  const db = new Database();
  const policy = { ...configuration().auth, origin: owned.url };
  let now = Date.now();
  const context = { db, clock: { now: () => new Date(now).toISOString() } };
  const files = new FileService(
    context,
    filePolicy,
    policy,
    owned.url,
    owned.directory,
  );
  const app = coreApp(context, 'test', policy, () => {}, {
    ...defaultRateOptions,
    enabled: false,
  });
  let server: ReturnType<typeof serve> | undefined;
  try {
    await owned.startInProcess(
      'file publication authority and ownership',
      async () => {
        await db.initialize();
        await files.initialize();
        fileRoutes(app, files);
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
        }
        await db.close();
      },
    );
    const client = new CoreHttp(owned.url);
    await client.register('authority@example.test');
    const sessionHeaders = () =>
      new Headers({
        cookie: client.cookie!,
        origin: owned.url,
        'x-csrf-token': client.csrf!,
      });
    const access = (headers = sessionHeaders()) =>
      requireAccess(context, policy, headers, 'file-access', 'lab:full', true);
    const bytes = Buffer.from('real immutable authority bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const start = async (actor: AccessActor, name: string) => {
      const cap = await db.transaction(
        { id: 'file-start', kind: 'request' },
        (tx) =>
          files.start(tx, actor, {
            file_name: name,
            content_type: 'text/plain',
            size: bytes.length,
            sha256,
          }),
      );
      const response = await fetch(cap.upload!.url, {
        method: 'PUT',
        headers: cap.upload!.headers,
        body: bytes,
      });
      assert.equal(response.status, 204);
      await response.arrayBuffer();
      return cap;
    };
    return {
      owned,
      db,
      files,
      client,
      bytes,
      sha256,
      access,
      start,
      advance: (millis: number) => {
        now += millis;
      },
    };
  } catch (error) {
    await owned.cleanup();
    throw error;
  }
}
for (const credential of ['session', 'api-key'] as const)
  test(`actual FileService refuses the revoked exact ${credential} after immutable filesystem adoption and recovers with a fresh credential`, async () => {
    const f = await fixture();
    let release = () => {};
    let finishing: Promise<unknown> | undefined;
    try {
      const key = async () =>
        f.client.json<CreatedApiKey>(
          'POST',
          '/api/v1/api-keys',
          { name: 'Publication key', scopes: ['lab:full'], expires_in_days: 1 },
          201,
        );
      let initialKey: CreatedApiKey | undefined;
      const actor =
        credential === 'session'
          ? await f.access()
          : await f.access(
              new Headers({
                authorization: `Bearer ${(initialKey = await key()).secret}`,
              }),
            );
      const cap = await f.start(actor, 'authority.txt');
      let entered!: () => void;
      const enter = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actualAdopt = f.files.blobs.adopt.bind(f.files.blobs);
      f.files.blobs.adopt = async (staged, hash) => {
        const physical = await actualAdopt(staged, hash);
        entered();
        await hold;
        return physical;
      };
      let published = false;
      finishing = f.files.complete(
        actor,
        cap.upload_id,
        'revoked-publication',
        async (tx, file) => {
          published = true;
          await f.files.pin(tx, file.id, {
            ownerType: 'owned-authority-proof',
            ownerId: file.id,
          });
          return file;
        },
      );
      finishing.catch(() => {});
      await enter;
      if (credential === 'session') {
        await f.client.json('POST', '/api/v1/auth/logout', undefined, 204);
        await f.client.login('authority@example.test');
      } else
        await f.client.json(
          'DELETE',
          `/api/v1/api-keys/${initialKey!.key.id}`,
          undefined,
          204,
        );
      const fresh =
        credential === 'session'
          ? await f.access()
          : await f.access(
              new Headers({ authorization: `Bearer ${(await key()).secret}` }),
            );
      assert.notEqual(fresh.credentialId, actor.credentialId);
      assert.equal(fresh.user.id, actor.user.id);
      release();
      await assert.rejects(
        finishing,
        (error: unknown) =>
          error instanceof PublicFailure && error.status === 401,
      );
      assert.equal(published, false);
      assert.equal(
        (
          await f.db.read({ id: 'refused-readback', kind: 'request' }, (tx) =>
            f.files.load(tx, cap.upload_id),
          )
        ).state,
        'pending_upload',
      );
      assert.deepEqual(
        (
          await f.client.json<AuditPage>(
            'GET',
            `/api/v1/audit-events?action=files.complete&resource_id=${cap.upload_id}`,
          )
        ).data,
        [],
      );
      f.files.blobs.adopt = actualAdopt;
      const ready = await f.files.complete(
        fresh,
        cap.upload_id,
        'healthy-publication',
        async (tx, file) => {
          await f.files.pin(tx, file.id, {
            ownerType: 'owned-authority-proof',
            ownerId: file.id,
          });
          return file;
        },
      );
      const download = await f.db.transaction(
        { id: 'healthy-download', kind: 'request' },
        (tx) => f.files.download(tx, fresh, ready.id),
      );
      const response = await fetch(download.url);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
      const audit = await f.client.json<AuditPage>(
        'GET',
        `/api/v1/audit-events?action=files.complete&resource_id=${cap.upload_id}`,
      );
      assert.equal(audit.data.length, 1);
      assert.equal(
        audit.data[0].actor_type,
        credential === 'session' ? 'user' : 'agent',
      );
    } finally {
      release();
      await Promise.allSettled(finishing ? [finishing] : []);
      await f.owned.cleanup();
    }
  });
test('actual cleanup and new adoption sharing a hash serialize while preserving the newly pinned signed bytes', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const actor = await f.access();
    const first = await f.start(actor, 'disposed.txt');
    const ready = await f.files.complete(
      actor,
      first.upload_id,
      'old-ready',
      async (_tx, file) => file,
    );
    const next = await f.start(actor, 'new.txt');
    await f.db.transaction({ id: 'old-dispose', kind: 'request' }, (tx) =>
      f.files.dispose(tx, ready.id),
    );
    let entered!: () => void;
    const enter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = f.files.blobs.withHash(f.sha256, async () => {
      entered();
      await hold;
    });
    await enter;
    const actualWithHash = f.files.blobs.withHash.bind(f.files.blobs);
    let queued!: () => void,
      contenders = 0;
    const bothQueued = new Promise<void>((resolve) => {
      queued = resolve;
    });
    f.files.blobs.withHash = <T>(hash: string, work: () => Promise<T>) => {
      if (hash === f.sha256 && ++contenders === 2) queued();
      return actualWithHash<T>(hash, work);
    };
    const cleaning = f.files.cleanup('racing-cleanup');
    const publishing = f.files.complete(
      actor,
      next.upload_id,
      'racing-adoption',
      async (tx, file) => {
        await f.files.pin(tx, file.id, {
          ownerType: 'owned-race-proof',
          ownerId: file.id,
        });
        return file;
      },
    );
    await bothQueued;
    release();
    await gate;
    assert.equal((await cleaning).deleted.includes(ready.id), true);
    const adopted = await publishing;
    const download = await f.db.transaction(
      { id: 'race-download', kind: 'request' },
      (tx) => f.files.download(tx, actor, adopted.id),
    );
    const response = await fetch(download.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  } finally {
    release();
    await f.owned.cleanup();
  }
});
test('real file validation signature expiry and recovery preserve declared size format limits and staged ownership', async () => {
  const f = await fixture();
  try {
    assert.equal(configuration({}).files.maxBytes, 20971520);
    const actor = await f.access();
    const start = (
      name: string,
      size = f.bytes.length,
      content_type = 'text/plain',
    ) =>
      f.db.transaction({ id: 'validation-start', kind: 'request' }, (tx) =>
        f.files.start(tx, actor, {
          file_name: name,
          content_type,
          size,
          sha256: f.sha256,
        }),
      );
    const put = async (cap: Awaited<ReturnType<typeof start>>) => {
      const response = await fetch(cap.upload!.url, {
        method: 'PUT',
        headers: cap.upload!.headers,
        body: f.bytes,
      });
      const status = response.status;
      await response.arrayBuffer();
      return status;
    };
    await assert.rejects(
      start('too-large', 20971521),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'files.too_large',
    );
    for (const [name, size, type] of [
      ['wrong-size', f.bytes.length + 1, 'text/plain'],
      ['wrong-format', f.bytes.length, 'image/png'],
    ] as const) {
      const cap = await start(name, size, type);
      assert.equal(await put(cap), 204);
      let published = false;
      await assert.rejects(
        f.files.complete(
          actor,
          cap.upload_id,
          'rejected-publication',
          async (_tx, file) => {
            published = true;
            return file;
          },
        ),
        (error: unknown) =>
          error instanceof PublicFailure &&
          error.code === 'files.upload_rejected',
      );
      assert.equal(published, false);
      assert.equal(
        (
          await f.db.read({ id: 'rejected-readback', kind: 'request' }, (tx) =>
            f.files.load(tx, cap.upload_id),
          )
        ).state,
        'rejected',
      );
      assert.deepEqual(
        (
          await f.client.json<AuditPage>(
            'GET',
            `/api/v1/audit-events?action=files.complete&resource_id=${cap.upload_id}`,
          )
        ).data,
        [],
      );
    }
    const missing = await start('missing-then-recovered');
    await assert.rejects(
      f.files.complete(
        actor,
        missing.upload_id,
        'missing-completion',
        async (_tx, file) => file,
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'files.upload_missing',
    );
    const tampered = new URL(missing.upload!.url);
    const signature = tampered.searchParams.get('signature')!;
    tampered.searchParams.set(
      'signature',
      (signature[0] === '0' ? '1' : '0') + signature.slice(1),
    );
    const invalid = await fetch(tampered, {
      method: 'PUT',
      headers: missing.upload!.headers,
      body: f.bytes,
    });
    assert.equal(invalid.status, 403);
    await invalid.arrayBuffer();
    assert.equal(await put(missing), 204);
    const ready = await f.files.complete(
      actor,
      missing.upload_id,
      'recovered-completion',
      async (tx, file) => {
        await f.files.pin(tx, file.id, {
          ownerType: 'owned-validation-proof',
          ownerId: file.id,
        });
        return file;
      },
    );
    const download = await f.db.transaction(
      { id: 'validation-download', kind: 'request' },
      (tx) => f.files.download(tx, actor, ready.id),
    );
    f.advance(defaultFilePolicy.downloadSecs * 1000 + 1);
    const expiredGet = await fetch(download.url);
    assert.equal(expiredGet.status, 410);
    await expiredGet.arrayBuffer();
    const fresh = await f.db.transaction(
      { id: 'fresh-download', kind: 'request' },
      (tx) => f.files.download(tx, actor, ready.id),
    );
    const healthy = await fetch(fresh.url);
    assert.equal(healthy.status, 200);
    assert.deepEqual(Buffer.from(await healthy.arrayBuffer()), f.bytes);
    const expiring = await start('expired-upload');
    f.advance(defaultFilePolicy.uploadSecs * 1000 + 1);
    assert.equal(await put(expiring), 410);
    await assert.rejects(
      f.files.complete(
        actor,
        expiring.upload_id,
        'expired-completion',
        async (_tx, file) => file,
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'files.upload_expired',
    );
    const healthHead = await fetch(f.owned.url + '/health/live', {
      method: 'HEAD',
    });
    assert.equal(healthHead.status, 200);
    await healthHead.arrayBuffer();
  } finally {
    await f.owned.cleanup();
  }
  const limited = await fixture(configuration({ FILE_MAX_BYTES: '5' }).files);
  try {
    const actor = await limited.access();
    await assert.rejects(
      limited.db.transaction(
        { id: 'configured-limit', kind: 'request' },
        (tx) =>
          limited.files.start(tx, actor, {
            file_name: 'six-bytes',
            content_type: 'text/plain',
            size: 6,
            sha256: limited.sha256,
          }),
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'files.too_large',
    );
  } finally {
    await limited.owned.cleanup();
  }
});
