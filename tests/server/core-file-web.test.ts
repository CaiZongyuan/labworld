import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { coreApp } from '../../apps/server/src/app.ts';
import { serve } from '../../apps/server/src/runtime.ts';
import { FileService } from '../../packages/server/src/core/files/use-cases.ts';
import { fileRoutes } from '../../packages/server/src/core/files/routes.ts';
import { requireAccess } from '../../packages/server/src/core/api-keys/authentication.ts';
test(
  'returned FileService PUT GET use the real Web proxy and preserve the api-keys SPA deep link',
  { timeout: 45000 },
  async () => {
    const backend = await new ServerProcess().create(),
      web = await new ServerProcess().create();
    const config = configuration({ APP_ORIGIN: web.url });
    const db = new Database(),
      context = { db, clock: { now: () => new Date().toISOString() } };
    const files = new FileService(
      context,
      config.files,
      config.auth,
      config.fileOrigin,
      backend.directory,
    );
    const app = coreApp(context, 'test', config.auth, () => {}, {
      ...config.rate,
      enabled: false,
    });
    let server: ReturnType<typeof serve> | undefined;
    web.entry = 'node_modules/vite/bin/vite.js';
    web.args = [
      'apps/web',
      '--config',
      'apps/web/vite.config.ts',
      '--host',
      '127.0.0.1',
    ];
    web.env = { WEB_PORT: String(web.port), VITE_API_PROXY: backend.url };
    try {
      await backend.startInProcess(
        'Web byte proxy Core service',
        async () => {
          await db.initialize();
          await files.initialize();
          fileRoutes(app, files);
          server = serve({
            fetch: app.fetch,
            hostname: '127.0.0.1',
            port: backend.port,
          });
        },
        async () => {
          if (server) {
            if ('closeAllConnections' in server) server.closeAllConnections();
            await new Promise<void>((resolve) =>
              server!.close(() => resolve()),
            );
          }
          await db.close();
        },
      );
      await web.start();
      const client = new CoreHttp(web.url);
      await client.register('web-file@example.test');
      const actor = await requireAccess(
        context,
        config.auth,
        new Headers({
          cookie: client.cookie!,
          origin: web.url,
          'x-csrf-token': client.csrf!,
        }),
        'web-file-access',
        'lab:full',
        true,
      );
      const bytes = Buffer.from('bytes through the real Web origin');
      const cap = await db.transaction(
        { id: 'web-file-start', kind: 'request' },
        (tx) =>
          files.start(tx, actor, {
            file_name: 'web.txt',
            content_type: 'text/plain',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }),
      );
      assert.equal(new URL(cap.upload!.url).origin, web.url);
      const put = await fetch(cap.upload!.url, {
        method: 'PUT',
        headers: cap.upload!.headers,
        body: bytes,
      });
      assert.equal(put.status, 204);
      await put.arrayBuffer();
      const ready = await files.complete(
        actor,
        cap.upload_id,
        'web-file-ready',
        async (tx, file) => {
          await files.pin(tx, file.id, {
            ownerType: 'owned-web-proof',
            ownerId: 'web',
          });
          return file;
        },
      );
      const download = await db.transaction(
        { id: 'web-file-download', kind: 'request' },
        (tx) => files.download(tx, actor, ready.id),
      );
      assert.equal(new URL(download.url).origin, web.url);
      const get = await fetch(download.url);
      assert.equal(get.status, 200);
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
      const page = await fetch(`${web.url}/api-keys`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/);
    } finally {
      await web.cleanup();
      await backend.cleanup();
    }
  },
);
