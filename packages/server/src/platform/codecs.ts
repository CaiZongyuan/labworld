import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { MeshoptDecoder } from 'meshoptimizer/decoder';
export class CodecUnavailable extends Error {
  constructor(cause: unknown) {
    super('Required file codec is temporarily unavailable', { cause });
  }
}
type ValidationExports = {
  memory: WebAssembly.Memory;
  allocate: (size: number) => number;
  deallocate: (pointer: number, size: number) => void;
  validate_draco: (
    pointer: number,
    size: number,
    points: number,
    ids: number,
    idsSize: number,
    decodedBytesLimit: number,
    pointLimit: number,
    faceLimit: number,
  ) => number;
  validate_image: (pointer: number, size: number, mime: number) => number;
  validate_glb_structure: (pointer: number, size: number) => number;
};
let validation: Promise<ValidationExports> | undefined;
let currentValidation: ValidationExports | undefined;
const failedValidation = new WeakSet<ValidationExports>();
function discardValidation(codec: ValidationExports) {
  failedValidation.add(codec);
  if (currentValidation === codec) {
    validation = undefined;
    currentValidation = undefined;
  }
}
async function validationCodec() {
  validation ??= readFile(
    new URL('../../codecs/validation/validation.wasm', import.meta.url),
  )
    .then(async (bytes) => {
      const { instance } = await WebAssembly.instantiate(bytes);
      const codec = instance.exports as unknown as ValidationExports;
      currentValidation = codec;
      return codec;
    })
    .catch((error) => {
      validation = undefined;
      currentValidation = undefined;
      throw new CodecUnavailable(error);
    });
  return validation;
}
function withBytes<T>(
  codec: ValidationExports,
  bytes: Uint8Array,
  work: (pointer: number) => T,
) {
  if (failedValidation.has(codec))
    throw new CodecUnavailable(new Error('Discarded validation codec'));
  let pointer: number | undefined;
  let value: T | undefined,
    failure: unknown,
    failed = false;
  try {
    pointer = codec.allocate(bytes.length) >>> 0;
    new Uint8Array(codec.memory.buffer, pointer, bytes.length).set(bytes);
    value = work(pointer);
  } catch (error) {
    failure = error;
    failed = true;
    discardValidation(codec);
  } finally {
    if (pointer !== undefined && !failedValidation.has(codec))
      try {
        codec.deallocate(pointer, bytes.length);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
        discardValidation(codec);
      }
  }
  if (failed) {
    discardValidation(codec);
    throw new CodecUnavailable(failure);
  }
  return value as T;
}
export async function decodeDraco(
  bytes: Uint8Array,
  points: boolean,
  requiredIds: number[],
  limits: { decodedBytes: number; points: number; faces: number },
) {
  const codec = await validationCodec();
  const ids = new Uint8Array(requiredIds.length * 4);
  const view = new DataView(ids.buffer);
  requiredIds.forEach((id, index) => view.setUint32(index * 4, id, true));
  return withBytes(codec, bytes, (pointer) =>
    withBytes(
      codec,
      ids,
      (idPointer) =>
        codec.validate_draco(
          pointer,
          bytes.length,
          Number(points),
          idPointer,
          ids.length,
          limits.decodedBytes,
          limits.points,
          limits.faces,
        ) === 1,
    ),
  );
}
export async function decodeImage(bytes: Uint8Array, mime: string) {
  const mimeId =
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].indexOf(mime) + 1;
  if (!mimeId) return false;
  const codec = await validationCodec();
  return withBytes(
    codec,
    bytes,
    (pointer) => codec.validate_image(pointer, bytes.length, mimeId) === 1,
  );
}
export async function validGlbStructure(bytes: Uint8Array) {
  const codec = await validationCodec();
  return withBytes(
    codec,
    bytes,
    (pointer) => codec.validate_glb_structure(pointer, bytes.length) === 1,
  );
}
export async function decodeMeshopt(
  bytes: Uint8Array,
  count: number,
  stride: number,
  mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES',
  filter: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL',
) {
  const decoder = await meshoptCodec();
  if (failedMeshopt.has(decoder))
    throw new CodecUnavailable(new Error('Discarded Meshopt codec'));
  const output = new Uint8Array(count * stride);
  try {
    decoder.decodeGltfBuffer(output, count, stride, bytes, mode, filter);
  } catch (error) {
    if (
      error instanceof Error &&
      /^Malformed buffer data: -?\d+$/.test(error.message)
    )
      throw error;
    resetMeshopt(decoder);
    throw new CodecUnavailable(error);
  }
  return output;
}
const require = createRequire(import.meta.url);
let meshopt: Promise<typeof MeshoptDecoder> | undefined;
let currentMeshopt: typeof MeshoptDecoder | undefined;
const failedMeshopt = new WeakSet<typeof MeshoptDecoder>();
function resetMeshopt(decoder?: typeof MeshoptDecoder) {
  if (decoder) {
    failedMeshopt.add(decoder);
    if (currentMeshopt !== decoder) return;
  }
  meshopt = undefined;
  currentMeshopt = undefined;
  try {
    delete require.cache[
      require.resolve('../../node_modules/meshoptimizer/meshopt_decoder.cjs')
    ];
  } catch {
    // A missing module has no cached instance; cleanup preserves the loader failure.
  }
}
async function meshoptCodec() {
  meshopt ??= Promise.resolve()
    .then(async () => {
      const decoder =
        require('../../node_modules/meshoptimizer/meshopt_decoder.cjs') as typeof MeshoptDecoder;
      await decoder.ready;
      currentMeshopt = decoder;
      return decoder;
    })
    .catch((error) => {
      resetMeshopt();
      throw new CodecUnavailable(error);
    });
  return meshopt;
}
type KtxFile = {
  isValid: () => boolean;
  getWidth: () => number;
  getHeight: () => number;
  getLayers: () => number;
  getFaces: () => number;
  getLevels: () => number;
  startTranscoding: () => boolean;
  getImageTranscodedSizeInBytes: (
    level: number,
    layer: number,
    face: number,
    format: number,
  ) => number;
  transcodeImage: (
    output: Uint8Array,
    level: number,
    layer: number,
    face: number,
    format: number,
    flags: number,
    channel0: number,
    channel1: number,
  ) => boolean;
  close: () => void;
  delete: () => void;
};
type Basis = {
  initializeBasis: () => void;
  KTX2File: new (bytes: Uint8Array) => KtxFile;
};
let basis: Promise<Basis> | undefined;
let currentBasis: Basis | undefined;
const failedBasis = new WeakSet<Basis>();
function discardBasis(codec: Basis) {
  failedBasis.add(codec);
  if (currentBasis === codec) {
    basis = undefined;
    currentBasis = undefined;
  }
}
async function basisCodec() {
  basis ??= readFile(
    new URL('../../codecs/basis/basis_transcoder.wasm', import.meta.url),
  )
    .then(async (wasmBinary) => {
      const factory = createRequire(import.meta.url)(
        '../../codecs/basis/basis_transcoder.cjs',
      ) as (options: { wasmBinary: Uint8Array }) => Promise<Basis>;
      const codec = await factory({ wasmBinary });
      codec.initializeBasis();
      currentBasis = codec;
      return codec;
    })
    .catch((error) => {
      basis = undefined;
      currentBasis = undefined;
      throw new CodecUnavailable(error);
    });
  return basis;
}
export async function decodeBasis(bytes: Uint8Array, limit: number) {
  const codec = await basisCodec();
  if (failedBasis.has(codec))
    throw new CodecUnavailable(new Error('Discarded Basis codec'));
  let file: KtxFile | undefined;
  let failure: unknown,
    failed = false,
    value = false;
  try {
    file = new codec.KTX2File(bytes);
    value = transcodeBasis(file, limit);
  } catch (error) {
    failure = error;
    failed = true;
    discardBasis(codec);
  } finally {
    if (file && !failedBasis.has(codec))
      try {
        file.close();
        file.delete();
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
        discardBasis(codec);
      }
  }
  if (failed) {
    discardBasis(codec);
    throw new CodecUnavailable(failure);
  }
  return value;
}
function transcodeBasis(file: KtxFile, limit: number) {
  if (
    !file.isValid() ||
    !file.getWidth() ||
    !file.getHeight() ||
    file.getWidth() * file.getHeight() * 4 > limit ||
    file.getLayers() > 1 ||
    file.getFaces() !== 1 ||
    !file.getLevels() ||
    !file.startTranscoding()
  )
    return false;
  for (let level = 0; level < file.getLevels(); level++) {
    const size = file.getImageTranscodedSizeInBytes(level, 0, 0, 13);
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > limit ||
      !file.transcodeImage(new Uint8Array(size), level, 0, 0, 13, 0, -1, -1)
    )
      return false;
  }
  return true;
}
