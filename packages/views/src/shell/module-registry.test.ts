import { describe, expect, test } from 'vitest';
import { CORE_RESERVED_ROUTES } from './app-contract';
import { coreModuleIcons } from './module-registry';

// The core half of the module registry (docs/ui/design.md §6 Q9):
// shell-owned pages map to fixed category colors explicitly — never via
// an algorithm — and the registry only ever names routes Core owns, so
// removing an example removes its color with it.

describe('coreModuleIcons', () => {
  test('every key is a Core-owned route', () => {
    for (const path of Object.keys(coreModuleIcons))
      expect(CORE_RESERVED_ROUTES).toContain(path);
  });

  test('every sidebar-visible Core page carries an icon', () => {
    for (const path of [
      '/',
      '/notifications',
      '/members',
      '/jobs',
      '/audit',
      '/api-keys',
      '/design-system',
      '/system',
      '/settings',
    ])
      expect(coreModuleIcons[path], path).toBeDefined();
  });

  test('auth pages stay unlisted — they render without the sidebar', () => {
    expect(coreModuleIcons['/login']).toBeUndefined();
    expect(coreModuleIcons['/register']).toBeUndefined();
  });
});
