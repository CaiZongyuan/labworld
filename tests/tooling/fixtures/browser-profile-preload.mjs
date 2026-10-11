import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

if (process.argv[1]?.endsWith('/scripts/e2e-server.mjs')) {
  const events = process.env.LAB_BROWSER_FIXTURE_EVENTS;
  const index = Number(
    process.env.LAB_NODE_BROWSER_PROFILE_INDEX ??
      (existsSync(events)
        ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).length
        : 0),
  );
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  child.unref();
  appendFileSync(
    events,
    JSON.stringify({
      index,
      args: process.argv.slice(2),
      webMode: process.env.E2E_WEB_MODE ?? null,
      pid: process.pid,
      descendant: child.pid,
    }) + '\n',
  );
  const summary = {
    status: index === 0 ? 'failed' : 'passed',
    runnerErrors: 0,
    tests: [
      {
        title: `Owned profile ${index}`,
        status: index === 0 ? 'failed' : 'passed',
        durationMs: 1,
        file: 'tests/e2e/owned.spec.ts',
        line: 1,
        errorCount: index === 0 ? 1 : 0,
        failureLocations: [],
      },
    ],
  };
  mkdirSync(join(process.cwd(), 'test-results'), { recursive: true });
  writeFileSync(
    join(process.cwd(), 'test-results/summary.json'),
    JSON.stringify(summary) + '\n',
  );
  if (process.env.LAB_NODE_BROWSER_PROFILE_RESULT)
    writeFileSync(
      process.env.LAB_NODE_BROWSER_PROFILE_RESULT,
      JSON.stringify({
        cleanupCompleted:
          process.env.LAB_BROWSER_FIXTURE_CLEANUP_FAILURE !== 'true',
        browserLedger: null,
        serviceLedgers: [],
      }) + '\n',
    );
  process.exit(index === 0 ? 1 : 0);
}
