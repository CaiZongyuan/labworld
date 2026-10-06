import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
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
async function validationCodec() {
  validation ??= readFile(
    new URL('../../codecs/validation/validation.wasm', import.meta.url),
  ).then(async (bytes) => {
    const { instance } = await WebAssembly.instantiate(bytes);
    return instance.exports as unknown as ValidationExports;
  });
  return validation;
}
function withBytes<T>(
  codec: ValidationExports,
  bytes: Uint8Array,
  work: (pointer: number) => T,
) {
  const pointer = codec.allocate(bytes.length);
  try {
    new Uint8Array(codec.memory.buffer, pointer, bytes.length).set(bytes);
    return work(pointer);
  } finally {
    codec.deallocate(pointer, bytes.length);
  }
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
  await MeshoptDecoder.ready;
  const output = new Uint8Array(count * stride);
  MeshoptDecoder.decodeGltfBuffer(output, count, stride, bytes, mode, filter);
  return output;
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
async function basisCodec() {
  basis ??= readFile(
    new URL('../../codecs/basis/basis_transcoder.wasm', import.meta.url),
  ).then(async (wasmBinary) => {
    const factory = createRequire(import.meta.url)(
      '../../codecs/basis/basis_transcoder.cjs',
    ) as (options: { wasmBinary: Uint8Array }) => Promise<Basis>;
    const codec = await factory({ wasmBinary });
    codec.initializeBasis();
    return codec;
  });
  return basis;
}
export async function decodeBasis(bytes: Uint8Array, limit: number) {
  const codec = await basisCodec();
  const file = new codec.KTX2File(bytes);
  try {
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
  } finally {
    file.close();
    file.delete();
  }
}
