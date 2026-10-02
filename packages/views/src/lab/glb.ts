export type ModelErrorKey =
  | 'format'
  | 'invalid'
  | 'external'
  | 'empty'
  | 'failed'
  | 'tooLarge'
  | 'denied'
  | 'storage';

export class ModelImportError extends Error {
  constructor(public readonly key: ModelErrorKey) {
    super(key);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateGLB(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 20) throw new ModelImportError('invalid');
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(12, true);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength ||
    buffer.byteLength % 4 !== 0 ||
    view.getUint32(16, true) !== 0x4e4f534a ||
    jsonLength % 4 !== 0 ||
    jsonLength > buffer.byteLength - 20
  )
    throw new ModelImportError('invalid');
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true })
        .decode(new Uint8Array(buffer, 20, jsonLength))
        .trim(),
    );
  } catch {
    throw new ModelImportError('invalid');
  }
  if (
    !record(document) ||
    !record(document.asset) ||
    document.asset.version !== '2.0'
  )
    throw new ModelImportError('invalid');
  for (const collection of [document.buffers, document.images]) {
    if (collection === undefined) continue;
    if (!Array.isArray(collection)) throw new ModelImportError('invalid');
    for (const entry of collection) {
      if (!record(entry)) throw new ModelImportError('invalid');
      if (entry.uri === undefined) continue;
      if (typeof entry.uri !== 'string') throw new ModelImportError('invalid');
      try {
        if (new URL(entry.uri).protocol !== 'data:')
          throw new ModelImportError('external');
      } catch {
        throw new ModelImportError('external');
      }
    }
  }
  if (
    !Array.isArray(document.meshes) ||
    !document.meshes.some(
      (mesh: unknown) =>
        record(mesh) &&
        Array.isArray(mesh.primitives) &&
        mesh.primitives.length > 0,
    )
  )
    throw new ModelImportError('empty');
}

export function readModelFile(
  file: File,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!/\.glb$/i.test(file.name))
    return Promise.reject(new ModelImportError('format'));
  if (signal?.aborted)
    return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    reader.onload = () => {
      cleanup();
      if (!reader.result || typeof reader.result === 'string') {
        reject(new ModelImportError('failed'));
        return;
      }
      try {
        validateGLB(reader.result);
        resolve(reader.result);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => {
      cleanup();
      reject(new ModelImportError('failed'));
    };
    reader.onabort = () => {
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    reader.readAsArrayBuffer(file);
  });
}
