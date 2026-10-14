import type { RecordingSegment } from '@labos-threejs/contracts';
import type { Client } from './generated/client';
import {
  getLabRecordingSegment,
  getLabRecordingResource,
} from './generated/sdk.gen';

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
  return readExactBytes(
    response,
    segment.size,
    segment.sha256,
    options.signal,
    'Recording segment',
  );
}

/** Read one retained scene dependency, independently of its current Asset. */
export async function readRecordingResource(options: {
  client: Client;
  labId: string;
  recordingId: string;
  resource: { file_id: string; size: number; sha256: string };
  signal?: AbortSignal;
  headers?: HeadersInit;
}): Promise<Uint8Array<ArrayBuffer>> {
  const resource = options.resource;
  if (
    !Number.isSafeInteger(resource.size) ||
    resource.size < 1 ||
    resource.size > 20 * 1024 * 1024 ||
    !/^[0-9a-f]{64}$/.test(resource.sha256)
  )
    throw new Error(
      'Select a Recording dependency within the 20 MiB read limit.',
    );
  options.signal?.throwIfAborted();
  const { response } = await getLabRecordingResource({
    client: options.client,
    path: {
      lab_id: options.labId,
      recording_id: options.recordingId,
      file_id: resource.file_id,
    },
    signal: options.signal,
    headers: Object.fromEntries(new Headers(options.headers)),
    parseAs: 'stream',
    responseStyle: 'fields',
    throwOnError: true,
  });
  return readExactBytes(
    response,
    resource.size,
    'sha256:' + resource.sha256,
    options.signal,
    'Recording resource',
  );
}

async function readExactBytes(
  response: Response,
  size: number,
  expectedHash: string,
  signal: AbortSignal | undefined,
  noun: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error(noun + ' response has no body.');
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && declared !== String(size))
      throw new Error(noun + ' Content-Length does not match its metadata.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > bytes.byteLength - offset)
        throw new Error(noun + ' exceeds its declared size.');
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new Error(noun + ' is truncated.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash =
      'sha256:' +
      Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== expectedHash)
      throw new Error(noun + ' SHA-256 does not match its metadata.');
    signal?.throwIfAborted();
    return bytes;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
