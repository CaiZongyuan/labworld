import { PGlite, type ExecProtocolOptions } from '@electric-sql/pglite';

/** Observe backend statement results, including PGlite's hidden transaction controls.
 * No splitting SQL: quoted semicolons and function bodies are one statement.
 * ErrorResponse counts an attempted failed statement; protocol parse/bind/sync do not.
 */
export class MeteredPGlite extends PGlite {
  onStatement?: (command: string) => void;
  beforeProtocol?: (message: Uint8Array) => void;
  override async execProtocolStream(
    message: Uint8Array,
    options: ExecProtocolOptions = {},
  ) {
    this.beforeProtocol?.(message);
    const results = await super.execProtocolStream(message, {
      ...options,
      throwOnError: false,
    });
    for (const result of results) {
      if (result.name === 'commandComplete')
        this.onStatement?.((result as unknown as { text: string }).text);
      else if (result.name === 'error') this.onStatement?.('ERROR');
    }
    const error = results.find((result) => result.name === 'error');
    if (error && options.throwOnError !== false) throw error;
    return results;
  }
}
