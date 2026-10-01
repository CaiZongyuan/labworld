import { expect, test } from '@playwright/test';
import { launchApp, requireSmokeEnv, signIn } from './helpers';

/**
 * Knowledge example inside the Electron shell: the seeded document is browsed
 * and previewed through the same shared views as in a browser. This spec is
 * owned by the knowledge example and skips when the example is removed, so
 * the core shell smoke keeps running without it.
 */

const documentTitle = process.env.DESKTOP_SMOKE_DOCUMENT_TITLE;
const documentMarker = process.env.DESKTOP_SMOKE_DOCUMENT_MARKER;

test('shell shows seeded knowledge documents through the shared views', async () => {
  if (!documentTitle || !documentMarker) {
    test.skip(true, 'knowledge example not seeded');
    return;
  }
  test.setTimeout(120_000);
  const { window, cleanup } = await launchApp();
  const appOrigin = new URL(requireSmokeEnv('E2E_WEB_URL')).origin;

  try {
    await signIn(window);

    await window.goto(`${appOrigin}/documents`);
    await window.getByRole('button', { name: documentTitle }).first().click();
    await expect(
      window.getByRole('heading', { name: documentTitle }),
    ).toBeVisible();
    // The Markdown preview renders the API-provided content safely.
    await expect(window.getByText(documentMarker)).toBeVisible();
  } finally {
    await cleanup();
  }
});
