import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  Database,
  type DbMeasurement,
} from '../../packages/server/src/platform/db/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { serve } from '../../apps/server/src/runtime.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { defaultFilePolicy } from '../../packages/server/src/core/files/domain.ts';
import { requireAccess } from '../../packages/server/src/core/api-keys/authentication.ts';
import { defaultRateOptions } from '../../packages/server/src/core/rate-limit/domain.ts';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

async function retiredScan(count: number) {
  const owned = await new ServerProcess().create();
  const measurements: DbMeasurement[] = [];
  let readFinished!: () => void;
  const read = new Promise<void>((resolve) => {
    readFinished = resolve;
  });
  const scanId = `scan-${count}`;
  const db = new Database(undefined, (measurement) => {
    measurements.push(measurement);
    if (
      measurement.id === scanId &&
      measurement.kind === 'background' &&
      !measurement.commands.includes('BEGIN')
    )
      readFinished();
  });
  const policy = { ...configuration().auth, origin: owned.url };
  let now = Date.now();
  const context = { db, clock: { now: () => new Date(now).toISOString() } };
  const app = coreApp(context, 'test', policy, () => {}, {
    ...defaultRateOptions,
    enabled: false,
  });
  const files = new FileService(
    context,
    defaultFilePolicy,
    policy,
    owned.url,
    owned.directory,
  );
  let server: ReturnType<typeof serve> | undefined;
  let release: () => void = () => {};
  try {
    await owned.startInProcess(
      'bounded orphan scan and unrelated HTTP',
      async () => {
        await db.initialize();
        await files.initialize();
        server = serve({
          fetch: app.fetch,
          hostname: '127.0.0.1',
          port: owned.port,
        });
      },
      async () => {
        release();
        if (server) {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        await db.close();
      },
    );
    const client = new CoreHttp(owned.url);
    await client.register('bounded-scan@example.test');
    const actor = await requireAccess(
      context,
      policy,
      new Headers({
        cookie: client.cookie!,
        origin: owned.url,
        'x-csrf-token': client.csrf!,
      }),
      'access',
      'lab:full',
      true,
    );
    const bytes = Buffer.from(
      'same hash with accumulated retired logical files',
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    for (let index = 0; index < count; index++) {
      const cap = await db.transaction(
        { id: 'retired-start', kind: 'request' },
        (tx) =>
          files.start(tx, actor, {
            file_name: `retired-${index}`,
            content_type: 'text/plain',
            size: bytes.length,
            sha256,
          }),
      );
      await db.transaction({ id: 'retired-dispose', kind: 'request' }, (tx) =>
        files.dispose(tx, cap.upload_id),
      );
    }
    for (let batch = 0; batch < Math.ceil(count / 50); batch++)
      await files.cleanup('retired-cleanup');
    const orphan = await files.blobs.stage(
      (async function* () {
        yield bytes;
      })(),
      defaultFilePolicy.maxBytes,
    );
    const key = await files.blobs.withHash(sha256, () =>
      files.blobs.adopt(orphan.key, sha256),
    );
    await files.blobs.remove(orphan.key);
    now = Date.now() + defaultFilePolicy.uploadSecs * 1000 + 1;
    let entered!: () => void;
    const enter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = files.blobs.withLock(key, async () => {
      entered();
      await hold;
    });
    await enter;
    const scanning = files.rescan(scanId);
    await read;
    const unrelated = await client.json<{ user: { id: string } }>(
      'GET',
      '/api/v1/auth/session',
    );
    assert.equal(unrelated.user.id, actor.user.id);
    release();
    await gate;
    const result = await scanning;
    assert.deepEqual(result.removed, [key]);
    return {
      count,
      readStatements: measurements
        .filter((m) => m.id === scanId && !m.commands.includes('BEGIN'))
        .map((m) => m.statements),
      httpSucceeded: true,
      result,
    };
  } finally {
    release();
    await owned.cleanup();
  }
}
test('actual orphan scans use the same bounded DB callbacks for one and one hundred retired rows and release the queue for HTTP', async () => {
  const small = await retiredScan(1),
    large = await retiredScan(100);
  assert.equal(
    Math.max(...large.readStatements),
    Math.max(...small.readStatements),
  );
  console.log(JSON.stringify({ event: 'rescan.bound-proof', small, large }));
});
