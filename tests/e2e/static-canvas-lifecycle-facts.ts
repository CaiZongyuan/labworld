import type { ConsoleMessage, Page } from '@playwright/test';

const prefix = '[static-canvas-lifecycle:v1]';
const phases = new Set([
  'lazy-start',
  'lazy-resolve',
  'lazy-reject',
  'viewport-enter',
  'viewport-commit',
  'canvas-created',
]);
type Event = {
  phase: string;
  epoch: number;
  browserAt: number;
  instance: number;
  receivedAt: number;
};

/** Diagnostic-only Node buffer; no measured-loop I/O or non-marker retention. */
export function observeStaticCanvasLifecycle(page: Page) {
  const events: Event[] = [];
  let dropped = 0;
  let listenerRegistered = false;
  const onConsole = (message: ConsoleMessage) => {
    try {
      if (message.type() !== 'debug') return;
      const text = message.text();
      if (!text.startsWith(prefix) || text.length > 256) return;
      const value: unknown = JSON.parse(text.slice(prefix.length));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const data = value as Record<string, unknown>;
      if (
        Object.keys(data).sort().join(',') !==
          'browserAt,epoch,instance,phase' ||
        typeof data.phase !== 'string' ||
        !phases.has(data.phase) ||
        typeof data.epoch !== 'number' ||
        !Number.isFinite(data.epoch) ||
        data.epoch <= 0 ||
        typeof data.browserAt !== 'number' ||
        !Number.isFinite(data.browserAt) ||
        data.browserAt < 0 ||
        typeof data.instance !== 'number' ||
        !Number.isInteger(data.instance) ||
        data.instance < 0 ||
        data.instance > 8
      )
        return;
      if (events.length >= 96) {
        dropped = Math.min(dropped + 1, Number.MAX_SAFE_INTEGER);
        return;
      }
      events.push({
        phase: data.phase,
        epoch: data.epoch,
        browserAt: data.browserAt,
        instance: data.instance,
        receivedAt: performance.now(),
      });
    } catch {
      // Console parsing cannot alter the original test.
    }
  };
  try {
    page.on('console', onConsole);
    listenerRegistered = true;
  } catch {
    // An unavailable observer is missing evidence, not a product verdict.
  }
  return {
    snapshot: () => ({
      listenerRegistered,
      cap: 96,
      dropped,
      events: [...events],
    }),
    dispose() {
      try {
        page.off('console', onConsole);
      } catch {
        // Preserve the original verdict if the page has already closed.
      }
    },
  };
}
