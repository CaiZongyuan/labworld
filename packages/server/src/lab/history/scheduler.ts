import type { HistoryService } from './use-cases.ts';
export function historyScheduler(
  history: HistoryService,
  log: (event: Record<string, unknown>) => void,
  intervalMs = 60000,
) {
  let stopped = false,
    current: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    if (stopped) return;
    if (current) return current;
    current = history.maintain().catch(() => {
      log({ event: 'history.maintenance_failed', code: 'lab.unavailable' });
    });
    try {
      await current;
    } finally {
      current = undefined;
    }
  }
  async function loop() {
    await tick();
    if (!stopped) {
      timer = setTimeout(() => void loop(), intervalMs);
      timer.unref();
    }
  }
  void loop();
  return {
    tick,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
