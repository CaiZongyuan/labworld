import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

test(
  'the spike runner refuses a failed final read and still cleans the owned service',
  { timeout: 60000 },
  async () => {
    const output = resolve(
      '.scratch/vnext-m1',
      `counterexample-${randomUUID()}`,
    );
    await mkdir(output, { recursive: true });
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/server-spike.ts',
        '--duration-seconds',
        '1',
        '--output',
        output,
        '--inject-final-read-failure',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    const failure = JSON.parse(
      await readFile(join(output, 'failure.json'), 'utf8'),
    );
    assert.match(failure.message, /404/);
    await assert.rejects(access(join(output, 'report.json')));
    const ledger = JSON.parse(
      await readFile(join(output, 'owned-resources.json'), 'utf8'),
    );
    assert.equal(ledger.state, 'cleaned');
    assert.deepEqual(ledger.processes, []);
  },
);

test(
  'a failed drift keeps the actual batch acknowledgment and phase boundaries before owned cleanup',
  { timeout: 60000 },
  async () => {
    const output = resolve(
      '.scratch/vnext-m1',
      `drift-receipt-${randomUUID()}`,
    );
    await mkdir(output, { recursive: true });
    const preload = join(output, 'delay-actual-batch-ack.mjs');
    await writeFile(
      preload,
      `
const actualFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await actualFetch(input, init);
  if (String(input).endsWith('/proof/samples') && init?.method === 'POST' && typeof init.body === 'string' && JSON.parse(init.body).length === 20) {
    const actualJson = response.json.bind(response);
    response.json = async () => {
      const acknowledged = await actualJson();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return acknowledged;
    };
  }
  return response;
};
`,
    );
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        preload,
        'scripts/server-spike.ts',
        '--duration-seconds',
        '1',
        '--output',
        output,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    const failure = JSON.parse(
      await readFile(join(output, 'failure.json'), 'utf8'),
    );
    assert.match(
      failure.message,
      /Tick1: commit drift .* exceeds one 1Hz cycle/,
    );
    assert.equal(
      failure.ticks,
      0,
      'failed timing is not counted as a successful tick',
    );
    assert.equal(failure.last_tick.tick, 1);
    assert.equal(failure.last_tick.acknowledged_rows, 20);
    assert.equal(failure.last_acknowledged.committed.length, 20);
    assert.ok(
      failure.last_tick.acknowledgment_ms >= 1000,
      'the deliberate delay belongs to acknowledgment consumption',
    );
    assert.equal(typeof failure.last_tick.request_id, 'string');
    const series = JSON.parse(
      await readFile(join(output, 'timeseries.json'), 'utf8'),
    );
    assert.equal(series.length, 1);
    assert.equal(series[0].tick, 1);
    await assert.rejects(access(join(output, 'report.json')));
    const ledger = JSON.parse(
      await readFile(join(output, 'owned-resources.json'), 'utf8'),
    );
    assert.equal(ledger.state, 'cleaned');
    assert.deepEqual(ledger.processes, []);
  },
);
