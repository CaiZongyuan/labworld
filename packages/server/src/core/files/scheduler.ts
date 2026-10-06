import { randomUUID } from 'node:crypto';
import type { FoundationContext } from '../../platform/context.ts';
import type { FileService } from './use-cases.ts';
export function fileScheduler(
  context: FoundationContext,
  files: FileService,
  log: (event: Record<string, unknown>) => void,
  intervalMs = 60000,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | undefined;
  async function tick() {
    if (stopped) return;
    if (current) return current;
    const id = `files:${randomUUID()}`;
    current = context.db
      .operation({ id, kind: 'background' }, async () => {
        const cleanup = await files.cleanup(id);
        const rescan = await files.rescan(id);
        log({
          event: 'files.maintenance',
          deleted: cleanup.deleted.length,
          retired: cleanup.retired.length,
          retained: cleanup.retained.length,
          orphan_removed: rescan.removed.length,
          orphan_retained: rescan.retained.length,
        });
      })
      .catch(() => {
        log({ event: 'files.maintenance_failed', code: 'files.unavailable' });
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
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
