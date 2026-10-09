import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { root } from './lib/process.mjs';

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
    };
    this.tests.push(entry);
    console.log(
      `${entry.status}: ${entry.title} (${entry.file}:${entry.line})`,
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
