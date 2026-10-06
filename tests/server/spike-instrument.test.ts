import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, access } from 'node:fs/promises';
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
