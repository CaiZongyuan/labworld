import { expect, type Locator } from '@playwright/test';

// Actual GitHub Ubuntu/SwiftShader rendered the correct 20-model scene after
// 9.269 seconds; the original default 5-second failure remains recorded:
// https://github.com/CaiZongyuan/labworld/actions/runs/38074047499
// Apply this only at first scene loads; later action/recovery budgets stay local.
export async function expectInitialSceneReady(scene: Locator) {
  await expect(scene).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
}
