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
import SafeBrowserReporter, {
  publicFailure,
} from '../../scripts/safe-browser-reporter.mjs';

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

test('public poll, case and action timeout facts preserve their distinct outcomes', () => {
  const predicate = publicFailure({
    message: 'Timeout 5000ms exceeded while waiting on the predicate',
  });
  assert.equal(predicate.timeoutKind, 'predicate');
  assert.equal(predicate.timeoutMs, 5000);
  assert.equal(predicate.numeric, null);
  const numeric = publicFailure({
    message:
      'expect(received).toBeGreaterThan(expected)\nExpected: > 30\nReceived: 0\nCall Log:\n- Timeout 5000ms exceeded while waiting on the predicate',
  });
  assert.deepEqual(numeric.numeric, {
    expected: 30,
    received: 0,
    operator: '>',
  });
  assert.equal(numeric.timeoutKind, 'predicate');
  assert.deepEqual(numeric.callLog, [
    { event: 'predicate-timeout', timeoutMs: 5000 },
  ]);
  const caseTimeout = publicFailure({
    message: 'Test timeout of 120000ms exceeded.',
  });
  assert.equal(caseTimeout.timeoutKind, 'case');
  assert.equal(caseTimeout.timeoutMs, 120000);
  const action = publicFailure({
    message:
      'locator.click: Timeout 30000ms exceeded.\nCall Log:\n- element is not stable',
  });
  assert.equal(action.timeoutKind, 'action');
  assert.equal(action.timeoutMs, 30000);
  assert.deepEqual(action.callLog, [
    { event: 'actionability', state: 'unstable' },
  ]);
});

test('timeout and action diagnostics retain only bounded facts and fixed states', () => {
  const secret = 'test-secret-identifier-must-not-be-retained';
  const cases = [
    'ReferenceError: ' + secret + ' is not defined',
    'locator.' + secret + ': Timeout 30000ms exceeded.',
    'Test timeout of 1000000001ms exceeded.',
    'expect(received).toBe(expected)\nExpected: "' +
      secret +
      '"\nReceived: { token: "' +
      secret +
      '" }',
  ];
  for (const message of cases) {
    const result = publicFailure({ message });
    assert.equal(result.timeoutMs, null);
    assert.equal(result.numeric, null);
    assert.equal(result.rawMessageRetained, false);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const intercepted = publicFailure({
    message:
      'locator.click: Timeout 30000ms exceeded.\nCall Log:\n- <div token="' +
      secret +
      '"> intercepts pointer events',
  });
  assert.deepEqual(intercepted.callLog, [
    { event: 'actionability', state: 'pointer-intercepted' },
  ]);
  assert.ok(!JSON.stringify(intercepted).includes(secret));
  const repeated = publicFailure({
    message: 'Call Log:\n' + '- element is not visible\n'.repeat(20),
  });
  assert.equal(repeated.callLog.length, 12);
});
