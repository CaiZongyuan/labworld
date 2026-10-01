import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '.agents/**',
      '.claude/**',
      '.scratch/**',
      'target/**',
      '**/node_modules/**',
      '**/dist/**',
      'apps/docs/.generated/**',
      'apps/docs/.vitepress/cache/**',
      'packages/sdk/src/generated/**',
      'packages/contracts/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['**/*.{ts,tsx,mts}'], rules: { 'no-undef': 'off' } },
  {
    // The load scenarios run under k6, not Node: its globals (env access,
    // VU counters, init-context file reads) are provided by the runtime.
    files: ['scripts/perf/k6/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' },
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
