import { defineConfig, devices } from '@playwright/test';

// The public-site journeys run against the built static documentation
// served by scripts/e2e-docs.mjs under the deployed base. No application
// stack is involved; the site's own checks already run in `just check`.
export default defineConfig({
  testDir: 'tests/docs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_DOCS_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: [
    ['./scripts/safe-browser-reporter.mjs', { outputDir: 'test-results/docs' }],
  ],
});
