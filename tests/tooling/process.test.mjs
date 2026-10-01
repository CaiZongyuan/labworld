import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort, launch, stop, waitFor } from '../../scripts/lib/process.mjs';

test(
  'stop ends the server descendants even when their wrapper exits first',
  { skip: process.platform === 'win32' },
  async (t) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = launch(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/term-parent.mjs', import.meta.url)),
        String(port),
      ],
      process.env,
    );
    t.after(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
    await waitFor(url, child);
    await stop(child);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  },
);
