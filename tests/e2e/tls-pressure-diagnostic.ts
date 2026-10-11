import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function pressureWindow(sessionId: string, clientPort: number) {
  const directory = process.env.TLS_PRESSURE_PROBE_DIR;
  if (!directory) return;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, 'window.json'),
      JSON.stringify({
        sessionId,
        clientPort,
        serverPort: Number(new URL(process.env.E2E_API_URL!).port),
        durationMs: 180000,
        testNodeAt: performance.now(),
        testMonoNs: process.hrtime.bigint().toString(),
        wallMs: Date.now(),
        clock: 'test Node performance.now; compare within this process',
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* Measurement setup must not replace the original predicate. */
  }
}

/** Capture the actual failed predicate and last bounded tuples before cleanup. */
export function pressureFailure(error: unknown) {
  const directory = process.env.TLS_PRESSURE_PROBE_DIR;
  if (!directory) return;
  try {
    const locations =
      error instanceof Error
        ? [
            ...(error.stack ?? '').matchAll(
              /(lab-secure-motion\.spec\.ts):(\d+):(\d+)/g,
            ),
          ]
            .slice(0, 4)
            .map((match) => ({
              file: match[1],
              line: Number(match[2]),
              column: Number(match[3]),
            }))
        : [];
    const files = readdirSync(directory).filter((name) =>
      /^(peer|source)-[0-9a-f-]{36}\.json$/.test(name),
    );
    const tuples = [
      'window.json',
      'server.json',
      'ss-owner.json',
      ...files.slice(0, 5),
    ].map((name) => {
      try {
        const bytes = readFileSync(join(directory, name));
        if (bytes.length > 16384)
          return { name, available: false, reason: 'tuple exceeds bound' };
        return {
          name,
          available: true,
          value: JSON.parse(bytes.toString('utf8')),
        };
      } catch {
        return { name, available: false, reason: 'unavailable tuple' };
      }
    });
    writeFileSync(
      join(directory, 'before-cleanup-failure.json'),
      JSON.stringify({
        testNodeAt: performance.now(),
        testMonoNs: process.hrtime.bigint().toString(),
        wallMs: Date.now(),
        errorClass:
          error instanceof Error &&
          ['Error', 'AssertionError', 'TimeoutError'].includes(error.name)
            ? error.name
            : 'unavailable',
        locations,
        rawMessageRetained: false,
        tuples,
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Diagnostic evidence must not replace the original failed assertion.
  }
}
