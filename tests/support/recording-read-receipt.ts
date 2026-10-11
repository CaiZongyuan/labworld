import { writeFileSync } from 'node:fs';

type Receipt = {
  nonce: string;
  pid: number;
  at: string;
  route: 'recording.events';
  status: number;
  expected: number;
  code: string | null;
  valid: boolean;
  elapsedMs: number;
};
let failed = false;

/** Observe only an already-failed HTTP response; preserve its original body. */
export async function captureRecordingReadFailure(
  response: Response,
  method: string,
  path: string,
  expected: number,
  destination = process.env.RECORDING_READ_RECEIPT,
  nonce = process.env.RECORDING_READ_NONCE,
  publish: (path: string, receipt: string) => void = (path, receipt) =>
    writeFileSync(path, receipt, { mode: 0o600 }),
) {
  if (
    !destination ||
    !nonce ||
    failed ||
    method !== 'GET' ||
    !/^\/api\/v1\/lab\/labs\/[0-9a-f-]{36}\/recordings\/[0-9a-f-]{36}\/events(?:\?|$)/.test(
      path,
    )
  )
    return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const started = performance.now();
  try {
    if (response.status === expected) return;
    reader = response.clone().body?.getReader();
    if (!reader) throw new Error('unavailable_body');
    const capture = async () => {
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader!.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16384) throw new Error('body_limit');
        chunks.push(next.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object') return null;
      const error = (value as { error?: unknown }).error;
      if (!error || typeof error !== 'object') return null;
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' &&
        /^lab\.recording_[a-z_]{1,64}$/.test(code)
        ? code
        : null;
    };
    const code = await Promise.race([
      capture(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('capture_timeout')), 250);
      }),
    ]);
    const receipt: Receipt = {
      nonce,
      pid: process.pid,
      at: new Date().toISOString(),
      route: 'recording.events',
      status: response.status,
      expected,
      code,
      valid: !failed && code !== null,
      elapsedMs: performance.now() - started,
    };
    publish(destination, JSON.stringify(receipt) + '\n');
  } catch {
    failed = true;
    // Missing receipt is unavailable evidence, never a replacement verdict.
  } finally {
    clearTimeout(timer);
    try {
      void reader?.cancel().catch(() => {});
    } catch {
      failed = true;
    }
  }
}
