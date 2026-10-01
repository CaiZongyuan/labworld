import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SafeBrowserReporter from '../../scripts/safe-browser-reporter.mjs';

test('retained browser evidence omits raw errors and discards sensitive page context', () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'labos-threejs-browser-report-'),
  );
  try {
    const secret = 'test-session-secret-must-not-be-retained';
    const context = join(directory, 'error-context.md');
    writeFileSync(context, `cookie: ${secret}`);
    const reporter = new SafeBrowserReporter({ outputDir: directory });
    reporter.onTestEnd(
      {
        title: 'authentication works',
        location: { file: '/repo/tests/auth.spec.ts', line: 10, column: 1 },
      },
      {
        status: 'failed',
        duration: 123,
        errors: [{ message: secret, stack: secret }],
        attachments: [{ name: 'error-context', path: context }],
      },
    );
    reporter.onEnd({ status: 'failed' });
    const report = readFileSync(join(directory, 'summary.json'), 'utf8');
    assert.ok(!report.includes(secret));
    assert.equal(JSON.parse(report).tests[0].status, 'failed');
    assert.equal(existsSync(context), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
