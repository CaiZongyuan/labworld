// Diagnostic branch only: real supervisor callback, no browser or machine actor.
import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processIdentity } from '../support/server-resources';

test('owned control publication barrier reaches the original supervisor parser', async () => {
  test.setTimeout(15000);
  const control = process.env.E2E_SERVICE_CONTROL;
  const evidence = process.env.LAB_NODE_EVIDENCE;
  assert(control && evidence);
  const writer = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
let descriptor = null;
process.once('SIGTERM', () => {
  let published = false;
  try {
    if (descriptor !== null) {
      writeSync(descriptor, JSON.stringify({ revision: 1, action: 'inspect-store' }));
      closeSync(descriptor);
      published = true;
    }
    writeFileSync(process.argv[2], JSON.stringify({
      owner: 'TLS control diagnostic producer',
      pid: process.pid,
      signal: 'SIGTERM',
      requestFullyPublished: published,
    }), { mode: 0o600 });
  } finally {
    process.exit(0);
  }
});
process.stdin.once('data', () => {
  descriptor = openSync(process.argv[1], 'w');
  process.stdout.write('barrier-held\\n');
});
process.stdin.resume();
`,
      control,
      join(evidence, 'tls-control-producer-final.json'),
    ],
    { env: process.env, stdio: ['pipe', 'pipe', 'ignore'], detached: false },
  );
  assert(writer.pid);
  const identity = await processIdentity(writer.pid);
  assert(identity);
  writeFileSync(
    join(evidence, 'tls-control-producer-intent.json'),
    JSON.stringify({
      owner: 'TLS control diagnostic producer',
      process: identity,
    }),
    { mode: 0o600 },
  );
  const barrier = once(writer.stdout!, 'data');
  writer.stdin!.write('go\n');
  const [ack] = await barrier;
  assert.equal(String(ack).trim(), 'barrier-held');
  // Original supervisor close supplies SIGTERM and releases the publication barrier.
  // Its existing process ledger owns this non-detached producer as a group member.
  await new Promise(() => {});
});
