import type { Page, ConsoleMessage, Frame } from '@playwright/test';
import { ReadinessLedger } from '../../packages/views/src/lab/readiness-observer';

/** No page evaluation or request: collect only the diagnostic producer's closed console facts. */
export function observeReadiness(page: Page) {
  const ledger = new ReadinessLedger();
  const consoleFact = (message: ConsoleMessage) => {
    const text = message.text();
    if (!text.startsWith('LAB_READINESS_FACT:')) return;
    try {
      if (text.length > 4096) {
        ledger.accept(null, performance.now());
        return;
      }
      ledger.accept(
        JSON.parse(text.slice('LAB_READINESS_FACT:'.length)),
        performance.now(),
      );
    } catch {
      ledger.accept(null, performance.now());
    }
  };
  const navigation = (frame: Frame) => {
    if (frame === page.mainFrame()) ledger.navigate();
  };
  page.on('console', consoleFact);
  page.on('framenavigated', navigation);
  return {
    stop() {
      page.off('console', consoleFact);
      page.off('framenavigated', navigation);
      return ledger.stop();
    },
  };
}
