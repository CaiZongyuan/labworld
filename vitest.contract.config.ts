import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include:
      process.env.CONTRACT_PROFILE === 'baseline' ||
      !process.env.CONTRACT_PROFILE
        ? ['tests/contract/**/!(*.config).test.ts']
        : process.env.CONTRACT_PROFILE === 'file-ttl'
          ? ['tests/contract/world-assets.test.ts']
          : [`tests/contract/${process.env.CONTRACT_PROFILE}.config.test.ts`],
    testNamePattern:
      process.env.CONTRACT_PROFILE === 'file-ttl'
        ? /^ASSET-04/
        : /^(?!ASSET-04)/,
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
