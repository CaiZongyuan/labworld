import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { root } from './lib/process.mjs';

const errorClasses = new Set([
  'Error',
  'AssertionError',
  'TimeoutError',
  'ProtocolError',
  'TargetClosedError',
  'TypeError',
  'ReferenceError',
]);
const matchers = new Set(['toHaveAttribute', 'toBeVisible', 'toHaveCount']);
const protocolMethods = new Set([
  'Runtime.callFunctionOn',
  'Runtime.evaluate',
  'Runtime.getProperties',
  'Page.captureScreenshot',
  'Page.getFrameTree',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getDocument',
]);

export function publicFailure(error) {
  if (!error) return null;
  const message = stripVTControlCharacters(error.message ?? '');
  const named = /^([A-Za-z]*Error):/.exec(message)?.[1];
  const matcher = /\b(toHaveAttribute|toBeVisible|toHaveCount)\b/.exec(
    message,
  )?.[1];
  const busy =
    message.includes("locator('.world-page')") && matcher === 'toHaveAttribute';
  const expected = /Expected(?: string)?:\s*"(true|false)"/.exec(message)?.[1];
  const received = /Received(?: string)?:\s*"(true|false)"/.exec(message)?.[1];
  const timeout = /Timeout:\s*(\d+)ms/.exec(message)?.[1];
  const count = /resolved to (\d+) elements/.exec(message)?.[1];
  const callLog = [];
  let inCallLog = false;
  for (const line of message.split('\n')) {
    if (line.startsWith('Call log:')) {
      inCallLog = true;
      continue;
    }
    if (!inCallLog || callLog.length >= 12) continue;
    const expectation = /Expect "([A-Za-z]+)" with timeout (\d+)ms/.exec(line);
    const unexpected = /unexpected value "(true|false)"/.exec(line);
    if (expectation && matchers.has(expectation[1]))
      callLog.push({
        event: 'expect',
        matcher: expectation[1],
        timeoutMs: Number(expectation[2]),
      });
    else if (line.includes("waiting for locator('.world-page')"))
      callLog.push({ event: 'waiting', locator: "locator('.world-page')" });
    else if (unexpected)
      callLog.push({ event: 'unexpected', value: unexpected[1] });
    else if (/locator resolved to/.test(line))
      callLog.push({ event: 'resolved', details: '<REDACTED>' });
  }
  const method =
    /Protocol error \((Runtime\.[A-Za-z]+|Page\.[A-Za-z]+|DOM\.[A-Za-z]+)\)/.exec(
      message,
    )?.[1];
  return {
    errorClass: named && errorClasses.has(named) ? named : 'OtherError',
    matcher: matcher && matchers.has(matcher) ? matcher : null,
    locator: busy ? "locator('.world-page')" : '<REDACTED>',
    busy: busy
      ? { expected: expected ?? null, received: received ?? null }
      : null,
    timeoutMs: timeout ? Number(timeout) : null,
    locatorMissing: /element\(s\) not found|No element matches/.test(message),
    strictLocatorMatches: count ? Number(count) : null,
    protocolMethod: method && protocolMethods.has(method) ? method : null,
    targetClosed:
      /Target page, context or browser has been closed|Target closed/.test(
        message,
      ),
    callLog,
    rawMessageRetained: false,
  };
}

// Failure objects, action arguments and page snapshots can contain credentials.
// Retain an allowlist of diagnostic metadata instead of serialized test results.
export default class SafeBrowserReporter {
  constructor(options = {}) {
    this.outputDir = options.outputDir ?? resolve(root, 'test-results');
    this.tests = [];
    this.runnerErrors = 0;
  }

  printsToStdio() {
    return true;
  }

  onTestEnd(test, result) {
    for (const attachment of result.attachments) {
      if (attachment.name === 'error-context' && attachment.path) {
        rmSync(attachment.path, { force: true });
      }
    }
    const entry = {
      title: test.title,
      status: result.status,
      durationMs: result.duration,
      file: relative(root, test.location.file),
      line: test.location.line,
      errorCount: result.errors.length,
      firstError: publicFailure(result.error ?? result.errors[0]),
      failureLocations: result.errors.flatMap((error) => {
        const pattern =
          /(?:\/|\\)(tests[\\/]e2e[\\/][A-Za-z0-9_.-]+):([0-9]+):([0-9]+)/g;
        return [...(error.stack ?? '').matchAll(pattern)].map((match) => ({
          file: match[1].replaceAll('\\', '/'),
          line: Number(match[2]),
          column: Number(match[3]),
        }));
      }),
    };
    this.tests.push(entry);
    console.log(
      `${entry.status}: ${entry.title} (${entry.file}:${entry.line})`,
    );
    for (const location of entry.failureLocations)
      console.log(
        `failure location: ${location.file}:${location.line}:${location.column}`,
      );
  }

  onError() {
    this.runnerErrors++;
    console.error(
      'Browser runner error; inspect the service/setup logs. Raw failure details are not retained.',
    );
  }

  onEnd(result) {
    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(
      join(this.outputDir, 'summary.json'),
      JSON.stringify(
        {
          status: result.status,
          runnerErrors: this.runnerErrors,
          tests: this.tests,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
