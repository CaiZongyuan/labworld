import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    maxWorkers: 2,
    include: ['packages/**/*.test.{ts,tsx}', 'apps/web/src/**/*.test.{ts,tsx}'],
    exclude: [
      'packages/server/**',
      'apps/web/src/desktop-preferences.test.tsx',
    ],
    setupFiles: ['tests/frontend/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
