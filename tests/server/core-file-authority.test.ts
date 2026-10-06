import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
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
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import type {
  CreatedApiKey,
  AuditPage,
} from '../../packages/contracts/src/generated/types.gen.ts';
async function fixture(
  filePolicy: FilePolicy = defaultFilePolicy,
  provided?: ServerProcess,
) {
  const owned = provided ?? (await new ServerProcess().create());
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
test('caller validates the same immutable candidate outside DB and refusal leaves no ready pin audit before healthy recovery', async () => {
  const f = await fixture();
  try {
    const actor = await f.access();
    const cap = await f.start(actor, 'validator.txt');
    let published = false;
    const validate = async (
      candidate: import('../../packages/server/src/core/files/use-cases.ts').VerifiedFile,
    ) => {
      assert.equal(candidate.file.sha256, f.sha256);
      const chunks: Uint8Array[] = [];
      for await (const bytes of candidate.read()) chunks.push(bytes);
      assert.deepEqual(Buffer.concat(chunks), f.bytes);
      assert.equal(
        (
          await f.client.json<{ user: { id: string } }>(
            'GET',
            '/api/v1/auth/session',
          )
        ).user.id,
        actor.user.id,
      );
    };
    await assert.rejects(
      f.files.complete(
        actor,
        cap.upload_id,
        'validator-refusal',
        async (tx, file) => {
          published = true;
          await f.files.pin(tx, file.id, {
            ownerType: 'owned-validator-proof',
            ownerId: file.id,
          });
          return file;
        },
        async (candidate) => {
          await validate(candidate);
          throw new PublicFailure(
            422,
            'files.validator_rejected',
            'Controlled candidate rejection',
          );
        },
      ),
      (error: unknown) =>
        error instanceof PublicFailure &&
        error.code === 'files.validator_rejected',
    );
    assert.equal(published, false);
    assert.equal(
      (
        await f.db.read({ id: 'validator-readback', kind: 'request' }, (tx) =>
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
    const sentinel = new Error('no pin retained');
    await assert.rejects(
      f.db.transaction(
        { id: 'validator-pin-probe', kind: 'request' },
        async (tx) => {
          await f.files.dispose(tx, cap.upload_id);
          throw sentinel;
        },
      ),
      (error) => error === sentinel,
    );
    const ready = await f.files.complete(
      actor,
      cap.upload_id,
      'validator-recovery',
      async (tx, file) => {
        await f.files.pin(tx, file.id, {
          ownerType: 'owned-validator-proof',
          ownerId: file.id,
        });
        return file;
      },
      validate,
    );
    assert.equal(ready.sha256, f.sha256);
    assert.equal(
      (
        await f.client.json<AuditPage>(
          'GET',
          `/api/v1/audit-events?action=files.complete&resource_id=${cap.upload_id}`,
        )
      ).data.length,
      1,
    );
  } finally {
    await f.owned.cleanup();
  }
});
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
test('new adoption after the last-reference GC decision waits for actual unlink and recreates exact immutable bytes', async () => {
  const f = await fixture();
  let release = () => {};
  let cleaning: ReturnType<FileService['cleanup']> | undefined,
    publishing: Promise<{ id: string }> | undefined;
  try {
    const actor = await f.access(),
      first = await f.start(actor, 'last-reference.txt');
    const ready = await f.files.complete(
      actor,
      first.upload_id,
      'last-reference-ready',
      async (_tx, file) => file,
    );
    await f.db.transaction(
      { id: 'last-reference-dispose', kind: 'request' },
      (tx) => f.files.dispose(tx, ready.id),
    );
    const key = `objects/${f.sha256.slice(0, 2)}/${f.sha256}`,
      steps: string[] = [];
    let deleting!: () => void;
    const decision = new Promise<void>((resolve) => {
      deleting = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualRemove = f.files.blobs.remove.bind(f.files.blobs),
      actualAdopt = f.files.blobs.adopt.bind(f.files.blobs);
    f.files.blobs.remove = async (location) => {
      if (location === key) {
        steps.push('gc-decision');
        deleting();
        await hold;
      }
      await actualRemove(location);
      if (location === key) steps.push('physical-unlinked');
    };
    f.files.blobs.adopt = async (staged, hash) => {
      const result = await actualAdopt(staged, hash);
      steps.push('new-adopted');
      return result;
    };
    cleaning = f.files.cleanup('last-reference-cleanup');
    cleaning.catch(() => {});
    await decision;
    const next = await f.start(actor, 'late-adoption.txt');
    steps.push('new-start');
    let queued!: () => void;
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const actualWithHash = f.files.blobs.withHash.bind(f.files.blobs);
    f.files.blobs.withHash = <T>(hash: string, work: () => Promise<T>) => {
      if (hash === f.sha256) queued();
      return actualWithHash<T>(hash, work);
    };
    publishing = f.files.complete(
      actor,
      next.upload_id,
      'late-adoption-ready',
      async (tx, file) => {
        await f.files.pin(tx, file.id, {
          ownerType: 'owned-late-adoption',
          ownerId: file.id,
        });
        return file;
      },
    );
    publishing.catch(() => {});
    await waiting;
    release();
    assert.equal((await cleaning).deleted.includes(ready.id), true);
    const adopted = await publishing;
    assert.deepEqual(steps, [
      'gc-decision',
      'new-start',
      'physical-unlinked',
      'new-adopted',
    ]);
    const download = await f.db.transaction(
      { id: 'late-adoption-download', kind: 'request' },
      (tx) => f.files.download(tx, actor, adopted.id),
    );
    const response = await fetch(download.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  } finally {
    release();
    try {
      await Promise.allSettled(
        [cleaning, publishing].filter((promise) => promise !== undefined),
      );
    } finally {
      await f.owned.cleanup();
    }
  }
});
test('expiry after immutable I/O refuses publication and file audit failure rolls ready and pin back before recovery', async () => {
  const f = await fixture();
  try {
    const actor = await f.access(),
      expired = await f.start(actor, 'expires-after-io.txt');
    let published = false;
    await assert.rejects(
      f.files.complete(
        actor,
        expired.upload_id,
        'post-io-expired',
        async (_tx, file) => {
          published = true;
          return file;
        },
        async (candidate) => {
          for await (const bytes of candidate.read())
            assert.equal(bytes.length > 0, true);
          f.advance(defaultFilePolicy.uploadSecs * 1000 + 1);
        },
      ),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'files.upload_expired',
    );
    assert.equal(published, false);
    assert.equal(
      (
        await f.db.read(
          { id: 'post-io-expired-state', kind: 'request' },
          (tx) => f.files.load(tx, expired.upload_id),
        )
      ).state,
      'pending_upload',
    );
    const audited = await f.start(actor, 'audit-rollback.txt');
    await assert.rejects(
      f.files.complete(
        actor,
        audited.upload_id,
        'caller-rollback',
        async (tx, file) => {
          await f.files.pin(tx, file.id, {
            ownerType: 'owned-caller-proof',
            ownerId: file.id,
          });
          throw new PublicFailure(
            409,
            'files.caller_conflict',
            'Controlled caller conflict',
          );
        },
      ),
      (error: unknown) =>
        error instanceof PublicFailure &&
        error.code === 'files.caller_conflict',
    );
    assert.equal(
      (
        await f.db.read(
          { id: 'caller-rollback-state', kind: 'request' },
          (tx) => f.files.load(tx, audited.upload_id),
        )
      ).state,
      'pending_upload',
    );
    const callerSentinel = new Error('caller pin rolled back');
    await assert.rejects(
      f.db.transaction(
        { id: 'caller-pin-probe', kind: 'request' },
        async (tx) => {
          await f.files.dispose(tx, audited.upload_id);
          throw callerSentinel;
        },
      ),
      (error) => error === callerSentinel,
    );
    await f.db.script(
      { id: 'file-publication-audit-fault', kind: 'startup' },
      `create function labos_threejs_core.reject_file_audit() returns trigger language plpgsql as $$ begin if NEW.action='files.complete' then raise exception 'controlled publication audit failure'; end if; return NEW; end $$; create trigger reject_file_audit before insert on labos_threejs_core.audit_events for each row execute function labos_threejs_core.reject_file_audit();`,
    );
    const publish = async (
      tx: Parameters<FileService['pin']>[0],
      file: { id: string },
    ) => {
      await f.files.pin(tx, file.id, {
        ownerType: 'owned-audit-proof',
        ownerId: file.id,
      });
      return file;
    };
    await assert.rejects(
      f.files.complete(actor, audited.upload_id, 'file-audit-failure', publish),
      (error: unknown) =>
        error instanceof PublicFailure && error.code === 'files.unavailable',
    );
    assert.equal(
      (
        await f.db.read({ id: 'file-audit-state', kind: 'request' }, (tx) =>
          f.files.load(tx, audited.upload_id),
        )
      ).state,
      'pending_upload',
    );
    assert.deepEqual(
      (
        await f.client.json<AuditPage>(
          'GET',
          `/api/v1/audit-events?action=files.complete&resource_id=${audited.upload_id}`,
        )
      ).data,
      [],
    );
    const sentinel = new Error('ready pin rolled back');
    await assert.rejects(
      f.db.transaction(
        { id: 'file-audit-pin', kind: 'request' },
        async (tx) => {
          await f.files.dispose(tx, audited.upload_id);
          throw sentinel;
        },
      ),
      (error) => error === sentinel,
    );
    await f.db.script(
      { id: 'file-publication-audit-recover', kind: 'startup' },
      'drop trigger reject_file_audit on labos_threejs_core.audit_events',
    );
    await f.files.complete(
      actor,
      audited.upload_id,
      'file-audit-recovery',
      publish,
    );
    assert.equal(
      (
        await f.client.json<AuditPage>(
          'GET',
          `/api/v1/audit-events?action=files.complete&resource_id=${audited.upload_id}`,
        )
      ).data.length,
      1,
    );
  } finally {
    await f.owned.cleanup();
  }
});
for (const interrupted of [false, true])
  test(
    interrupted
      ? 'controlled failure drains admitted cleanup adoption and hash gate before owned resource removal'
      : 'actual cleanup and new adoption sharing a hash serialize while preserving the newly pinned signed bytes',
    async () => {
      const f = await fixture();
      let release = () => {};
      let gate: Promise<void> | undefined,
        cleaning: ReturnType<FileService['cleanup']> | undefined,
        publishing: Promise<{ id: string }> | undefined;
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
        gate = f.files.blobs.withHash(f.sha256, async () => {
          entered();
          await hold;
        });
        gate.catch(() => {});
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
        cleaning = f.files.cleanup('racing-cleanup');
        cleaning.catch(() => {});
        publishing = f.files.complete(
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
        publishing.catch(() => {});
        await bothQueued;
        if (interrupted) throw new Error('controlled admitted task failure');
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
      } catch (error) {
        if (
          !interrupted ||
          !(error instanceof Error) ||
          error.message !== 'controlled admitted task failure'
        )
          throw error;
      } finally {
        release();
        try {
          const settled = await Promise.allSettled(
            [gate, cleaning, publishing].filter(
              (promise) => promise !== undefined,
            ),
          );
          if (interrupted) {
            assert.equal(settled.length, 3);
            assert.equal(
              settled.every((result) => result.status === 'fulfilled'),
              true,
            );
          }
        } finally {
          await f.owned.cleanup();
        }
      }
      assert.equal(f.owned.directory, '');
    },
  );
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
    const excess = Buffer.from('123456');
    const cap = await limited.db.transaction(
      { id: 'stream-limit-start', kind: 'request' },
      (tx) =>
        limited.files.start(tx, actor, {
          file_name: 'streamed-limit',
          content_type: 'text/plain',
          size: 5,
          sha256: createHash('sha256').update(excess).digest('hex'),
        }),
    );
    const response = await fetch(cap.upload!.url, {
      method: 'PUT',
      headers: cap.upload!.headers,
      body: excess,
    });
    assert.equal(response.status, 413);
    await response.arrayBuffer();
    const accepted = Buffer.from('12345');
    const fresh = await limited.db.transaction(
      { id: 'stream-limit-recovery', kind: 'request' },
      (tx) =>
        limited.files.start(tx, actor, {
          file_name: 'five-bytes',
          content_type: 'text/plain',
          size: 5,
          sha256: createHash('sha256').update(accepted).digest('hex'),
        }),
    );
    const recovery = await fetch(fresh.upload!.url, {
      method: 'PUT',
      headers: fresh.upload!.headers,
      body: accepted,
    });
    assert.equal(recovery.status, 204);
    await recovery.arrayBuffer();
  } finally {
    await limited.owned.cleanup();
  }
});

for (const fault of ['write', 'kill'] as const)
  test(`signing key ${fault} before publication recovers the same fresh owned directory and real signed bytes`, async () => {
    const owned = await new ServerProcess().create();
    owned.entry = 'tests/support/signing-key-fault.ts';
    owned.ipc = true;
    owned.env = { APP_ORIGIN: owned.url, OWNED_SIGNING_KEY_FAULT: fault };
    const stages: string[] = [];
    try {
      await owned.spawn();
      owned.child!.on('message', (message) =>
        stages.push((message as { stage: string }).stage),
      );
      await until(
        async () => stages.includes('partial-key-written'),
        (yes) => yes,
        10000,
      );
      if (fault === 'kill') await owned.stop('SIGKILL');
      else {
        if (owned.child!.exitCode === null) await once(owned.child!, 'exit');
        await owned.stop();
      }
      const f = await fixture(defaultFilePolicy, owned);
      const actor = await f.access(),
        cap = await f.start(actor, 'key-recovery.txt');
      const ready = await f.files.complete(
        actor,
        cap.upload_id,
        'key-recovery-publish',
        async (tx, file) => {
          await f.files.pin(tx, file.id, {
            ownerType: 'owned-key-recovery',
            ownerId: file.id,
          });
          return file;
        },
      );
      const download = await f.db.transaction(
        { id: 'key-recovery-download', kind: 'request' },
        (tx) => f.files.download(tx, actor, ready.id),
      );
      const response = await fetch(download.url);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    } finally {
      await owned.cleanup();
    }
  });

test('an existing unknown short canonical signing key is refused and preserved', async () => {
  const owned = await new ServerProcess().create();
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const key = join(owned.directory, 'secrets', 'file-signing-key');
  const unknown = Buffer.from('unknown');
  try {
    await mkdir(join(owned.directory, 'secrets'), { recursive: true });
    await writeFile(key, unknown, { flag: 'wx', mode: 0o600 });
    const config = configuration();
    const service = new FileService(
      { db: new Database(), clock: { now: () => new Date().toISOString() } },
      defaultFilePolicy,
      config.auth,
      owned.url,
      owned.directory,
    );
    await assert.rejects(service.initialize(), /File signing key is invalid/);
    assert.deepEqual(await readFile(key), unknown);
  } finally {
    await owned.cleanup();
  }
});
