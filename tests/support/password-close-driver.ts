import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const actual = await import(process.env.OWNED_CLOSE_DRIVER_URL!);
export const types = actual.types;
export class PGlite extends actual.PGlite {
  constructor(...args: unknown[]) {
    super(...args);
    const actualClose = this.close;
    this.close = async () => {
      await actualClose.call(this);
      // A real owned filesystem failure rejects the public close promise after
      // the actual embedded DB closes. No private business repository mock.
      await readFile(
        join(process.env.LAB_WORD_DATA_DIR!, 'owned-close-fault-missing'),
      );
    };
  }
}
