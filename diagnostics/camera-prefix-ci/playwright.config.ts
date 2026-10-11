import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';
export default defineConfig({
  ...base,
  testDir: '.',
  reporter: [['../../scripts/safe-browser-reporter.mjs']],
});
