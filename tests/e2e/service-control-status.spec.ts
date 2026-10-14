import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { publishServiceControlRequest } from '../support/service-control-request';

test('a partial control publication keeps the previous request readable until the supervisor receives the complete revision', async () => {
  test.setTimeout(15000);
  const control = process.env.E2E_SERVICE_CONTROL;
  const reply = process.env.E2E_SERVICE_CONTROL_REPLY;
  const evidence = process.env.LAB_NODE_EVIDENCE;
  assert(control && reply && evidence);
  const originalWrite = fs.writeFile;
  let release!: () => void;
  let acknowledge!: (path: string) => void;
  let temporary: string | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const barrier = new Promise<string>((resolve) => {
    acknowledge = resolve;
  });
  fs.writeFile = async (...args) => {
    const path = args[0];
    if (
      !temporary &&
      typeof path === 'string' &&
      (path === control || path.startsWith(control + '.'))
    ) {
      temporary = path;
      const handle = await fs.open(path, 'w');
      await handle.close();
      acknowledge(path);
      await released;
    }
    return originalWrite(...args);
  };
  syncBuiltinESMExports();
  const publication = publishServiceControlRequest(control, {
    revision: 1,
    action: 'inspect-store',
  });
  try {
    await barrier;
    expect(JSON.parse(await fs.readFile(control, 'utf8')).revision).toBe(0);
    release();
    await publication;
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(reply, 'utf8')).revision;
        } catch {
          return 0;
        }
      })
      .toBe(1);
    assert(temporary);
    const remaining = await fs.stat(temporary).then(
      () => true,
      (error) => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      },
    );
    expect(remaining).toBe(false);
    await originalWrite(
      join(evidence, 'service-control-publication.json'),
      JSON.stringify({
        previousRevisionWhilePartial: 0,
        acknowledgedRevision: 1,
        temporaryName: basename(temporary),
        temporaryRemoved: true,
      }),
      { mode: 0o600 },
    );
  } finally {
    release();
    await publication.catch(() => {});
    fs.writeFile = originalWrite;
    syncBuiltinESMExports();
  }
});
