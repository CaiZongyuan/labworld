import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: [
      'packages/**/*.test.{ts,tsx}',
      'apps/web/src/**/*.test.{ts,tsx}',
      'apps/desktop/src/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['tests/frontend/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
