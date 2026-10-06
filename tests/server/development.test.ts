import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ServerProcess,
  availablePort,
  until,
} from '../support/server-process.ts';

test(
  'the real development entrypoint starts Web and proxies foundation HTTP without external services',
  { timeout: 60000 },
  async () => {
    const target = await new ServerProcess().create();
    target.entry = 'scripts/server-dev.ts';
    const webPort = await availablePort();
    target.env.WEB_PORT = String(webPort);
    try {
      await target.start();
      const web = `http://127.0.0.1:${webPort}`;
      const ready = await until(
        async () => fetch(`${web}/health/ready`),
        (r) => r.status === 200,
      );
      assert.deepEqual(await ready.json(), { status: 'ok' });
      const status = (await (
        await fetch(`${web}/api/v1/system/status`)
      ).json()) as { service: string; database: string };
      assert.equal(status.service, 'labos-threejs-api');
      assert.equal(status.database, 'connected');
      const page = await fetch(`${web}/api-keys`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/);
    } finally {
      await target.cleanup();
    }
  },
);
