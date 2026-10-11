import type { RecordingSegment } from '@labos-threejs/contracts';
import type { Client } from './generated/client';
import { getLabRecordingSegment } from './generated/sdk.gen';

const MAX_SEGMENT_BYTES = 1024 * 1024;

/** Read one immutable segment; the caller owns page selection and retention. */
export async function readRecordingSegment(options: {
  client: Client;
  labId: string;
  recordingId: string;
  segment: RecordingSegment;
  signal?: AbortSignal;
  headers?: HeadersInit;
}): Promise<Uint8Array<ArrayBuffer>> {
  const segment = options.segment;
  if (
    !segment.sealed ||
    !Number.isInteger(segment.size) ||
    segment.size < 1 ||
    segment.size > MAX_SEGMENT_BYTES ||
    !/^sha256:[0-9a-f]{64}$/.test(segment.sha256)
  )
    throw new Error(
      'Select a sealed Recording segment within the 1 MiB read limit.',
    );
  options.signal?.throwIfAborted();
  const { response } = await getLabRecordingSegment({
    client: options.client,
    path: {
      lab_id: options.labId,
      recording_id: options.recordingId,
      segment_id: segment.id,
    },
    signal: options.signal,
    headers: Object.fromEntries(new Headers(options.headers)),
    parseAs: 'stream',
    responseStyle: 'fields',
    throwOnError: true,
  });
  if (!response.body)
    throw new Error('Recording segment response has no body.');
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && declared !== String(segment.size))
      throw new Error(
        'Recording segment Content-Length does not match its metadata.',
      );
    const bytes = new Uint8Array(segment.size);
    let offset = 0;
    while (true) {
      options.signal?.throwIfAborted();
      const { value, done } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > bytes.byteLength - offset)
        throw new Error('Recording segment exceeds its declared size.');
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== segment.size)
      throw new Error('Recording segment is truncated.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash =
      'sha256:' +
      Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== segment.sha256)
      throw new Error('Recording segment SHA-256 does not match its metadata.');
    options.signal?.throwIfAborted();
    return bytes;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
