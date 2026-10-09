import { defineConfig } from '@playwright/test';

// The desktop soak runs only from scripts/perf/desktop-soak.mjs (nightly /
// release material, never the shell smoke and never a PR gate); this config
// keeps it out of the smoke's testMatch. Same evidence discipline: list
// reporter, no traces or screenshots.
export default defineConfig({
  testDir: '.',
  testMatch: 'soak.spec.ts',
  timeout: 1_800_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: '../../test-results/desktop-soak',
});
