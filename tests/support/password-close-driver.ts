import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const started = performance.now();
const phases: Array<{
  phase: string;
  at: string;
  elapsedMs: number;
  code?: string;
}> = [];
function phase(name: string, code?: string) {
  phases.push({
    phase: name,
    at: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    ...(code ? { code } : {}),
  });
  const path = process.env.OWNED_PASSWORD_CLOSE_FACTS;
  if (path) {
    try {
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, phases }, null, 2),
      );
    } catch {
      /* Evidence cannot replace the actual driver outcome. */
    }
  }
}
phase('driver-loading');
const actual = await import(process.env.OWNED_CLOSE_DRIVER_URL!);
phase('driver-loaded');
export const types = actual.types;
export class PGlite extends actual.PGlite {
  constructor(...args: unknown[]) {
    super(...args);
    phase('db-created');
    void this.waitReady.then(
      () => phase('db-ready'),
      () => phase('db-ready-error'),
    );
    const actualClose = this.close;
    this.close = async () => {
      phase('close-started');
      await actualClose.call(this);
      phase('db-closed');
      // A real owned filesystem failure rejects the public close promise after
      // the actual embedded DB closes. No private business repository mock.
      try {
        await readFile(
          join(process.env.LAB_WORD_DATA_DIR!, 'owned-close-fault-missing'),
        );
      } catch (error) {
        phase(
          'controlled-filesystem-rejection',
          (error as NodeJS.ErrnoException).code,
        );
        throw error;
      }
    };
  }
}
