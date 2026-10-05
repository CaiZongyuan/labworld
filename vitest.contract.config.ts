import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/contract/**/*.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 45_000,
    hookTimeout: 45_000,
    reporters: ['default', 'json'],
    outputFile: {
      json: process.env.CONTRACT_REPORT ?? '.scratch/vnext-m0/results.json',
    },
  },
});
