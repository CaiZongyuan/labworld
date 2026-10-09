import { defineConfig } from '@playwright/test';

// The Electron shell smoke runs against a stack started by
// scripts/desktop-smoke.mjs; it never starts its own web server.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // The desktop soak has its own config and runner (scripts/perf/
  // desktop-soak.mjs); the smoke must never pick it up.
  testIgnore: ['soak.spec.ts'],
  timeout: 120_000,
  // One worker: every spec shares the single real stack and each launch
  // starts an Electron process, so parallel workers only add contention.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Failure evidence stays console-local: no traces or screenshots that
  // could contain session or document content.
  reporter: [['list']],
  outputDir: '../../test-results/desktop',
});
