import {
  decodeBasis,
  decodeDraco,
  decodeImage,
  decodeMeshopt,
  validGlbStructure,
} from '../../platform/codecs.ts';
export const MAX_DECODED_RESOURCE_BYTES = 256 * 1024 * 1024;
type Extensions = Record<string, unknown>;
type BufferDefinition = {
  byteLength: number;
  uri?: string;
  extensions?: Extensions;
};
type View = {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: Extensions;
};
type Accessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
};
type Primitive = {
  mode?: number;
  attributes: Record<string, number>;
  indices?: number;
  extensions?: Extensions;
};
type Root = {
  buffers?: BufferDefinition[];
  bufferViews?: View[];
  accessors?: Accessor[];
  meshes?: { primitives: Primitive[] }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  textures?: { source?: number; extensions?: Extensions }[];
};
type Meshopt = {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride: number;
  count: number;
  mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
  filter?: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';
};
type Draco = { bufferView: number; attributes: Record<string, number> };
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function range(bytes: Uint8Array, offset: number, length: number) {
  if (
    !integer(offset) ||
    !integer(length) ||
    !Number.isSafeInteger(offset + length) ||
    offset + length > bytes.length
  )
    throw new Error('Invalid byte range');
  return bytes.subarray(offset, offset + length);
}
function dataUri(uri: string) {
  const match = /^data:([^,]*),(.*)$/s.exec(uri);
  if (!match) throw new Error('External resource');
  const mime = match[1].split(';')[0] || 'text/plain';
  const raw = Buffer.from(match[2], 'utf8');
  const decoded = Buffer.allocUnsafe(raw.length);
  let length = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== 37) {
      decoded[length++] = raw[index];
      continue;
    }
    const pair = raw.toString('ascii', index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/i.test(pair)) throw new Error('Invalid data URI');
    decoded[length++] = Number.parseInt(pair, 16);
    index += 2;
  }
  const encodedBytes = decoded.subarray(0, length);
  const encoded = encodedBytes.toString('ascii');
  if (
    match[1].endsWith(';base64') &&
    (encodedBytes.some((byte) => byte > 127) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      ))
  )
    throw new Error('Invalid data URI');
  return {
    mime,
    bytes: new Uint8Array(
      match[1].endsWith(';base64')
        ? Buffer.from(encoded, 'base64')
        : encodedBytes,
    ),
  };
}
function parts(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const root = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      range(bytes, 20, jsonLength),
    ),
  ) as Root;
  let binary: Uint8Array = new Uint8Array();
  for (let offset = 20 + jsonLength; offset < bytes.length;) {
    const length = view.getUint32(offset, true),
      type = view.getUint32(offset + 4, true);
    if (type === 0x004e4942) binary = range(bytes, offset + 8, length);
    offset += 8 + length;
  }
  return { root, binary };
}
const fallback = (buffer: BufferDefinition) =>
  (
    buffer.extensions?.EXT_meshopt_compression as
      { fallback?: boolean } | undefined
  )?.fallback === true;
async function loadBuffers(root: Root, binary: Uint8Array) {
  let declared = 0;
  const borrowed = new Set<number>();
  const buffers = (root.buffers ?? []).map((buffer, index) => {
    declared += buffer.byteLength;
    if (!integer(declared) || declared > MAX_DECODED_RESOURCE_BYTES)
      throw new Error('Expanded buffers');
    const data = buffer.uri
      ? dataUri(buffer.uri).bytes
      : fallback(buffer)
        ? new Uint8Array(buffer.byteLength)
        : index === 0
          ? binary
          : undefined;
    if (!data || data.length < buffer.byteLength)
      throw new Error('Missing buffer');
    if (!buffer.uri && !fallback(buffer)) borrowed.add(index);
    return data;
  });
  for (const view of root.bufferViews ?? []) {
    const extension = view.extensions?.EXT_meshopt_compression as
      Meshopt | undefined;
    if (!extension) continue;
    const {
      buffer,
      byteOffset = 0,
      byteLength,
      count,
      byteStride,
      mode,
      filter = 'NONE',
    } = extension;
    if (
      !integer(buffer) ||
      !root.buffers?.[buffer] ||
      fallback(root.buffers[buffer]) ||
      !integer(count) ||
      !integer(byteStride) ||
      !Number.isSafeInteger(count * byteStride) ||
      count * byteStride !== view.byteLength ||
      count * byteStride > MAX_DECODED_RESOURCE_BYTES ||
      !['ATTRIBUTES', 'TRIANGLES', 'INDICES'].includes(mode) ||
      !['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL'].includes(filter)
    )
      throw new Error('Invalid Meshopt');
    const output = await decodeMeshopt(
      range(buffers[buffer], byteOffset, byteLength),
      count,
      byteStride,
      mode,
      filter,
    );
    const target = buffers[view.buffer];
    if (!target) throw new Error('Missing target buffer');
    // Own a copy before replacing a compressed fallback view; original GLB bytes stay immutable.
    if (borrowed.delete(view.buffer))
      buffers[view.buffer] = new Uint8Array(target);
    range(buffers[view.buffer], view.byteOffset ?? 0, view.byteLength).set(
      output,
    );
  }
  return buffers;
}
function viewBytes(root: Root, buffers: Uint8Array[], index: number) {
  const view = root.bufferViews?.[index];
  if (!view || !buffers[view.buffer]) throw new Error('Missing buffer view');
  return range(buffers[view.buffer], view.byteOffset ?? 0, view.byteLength);
}
const sizes: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const components: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
function scalar(bytes: Uint8Array, offset: number, type: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 5120) return view.getInt8(offset);
  if (type === 5121) return view.getUint8(offset);
  if (type === 5122) return view.getInt16(offset, true);
  if (type === 5123) return view.getUint16(offset, true);
  if (type === 5125) return view.getUint32(offset, true);
  if (type === 5126) return view.getFloat32(offset, true);
  throw new Error('Invalid component type');
}
function accessorValues(
  root: Root,
  buffers: Uint8Array[],
  accessor: Accessor,
  visit: (value: number) => boolean,
) {
  const width = sizes[accessor.componentType],
    dimensions = components[accessor.type];
  const elementSize = width * dimensions;
  const sparse = accessor.sparse;
  const indices = sparse
    ? viewBytes(root, buffers, sparse.indices.bufferView)
    : undefined;
  const values = sparse
    ? viewBytes(root, buffers, sparse.values.bufferView)
    : undefined;
  let sparseIndex = 0;
  const ordinary =
    accessor.bufferView === undefined
      ? undefined
      : viewBytes(root, buffers, accessor.bufferView);
  const stride =
    accessor.bufferView === undefined
      ? elementSize
      : (root.bufferViews![accessor.bufferView].byteStride ?? elementSize);
  for (let index = 0; index < accessor.count; index++) {
    const sparseAt =
      sparse && sparseIndex < sparse.count
        ? scalar(
            indices!,
            (sparse.indices.byteOffset ?? 0) +
              sparseIndex * sizes[sparse.indices.componentType],
            sparse.indices.componentType,
          )
        : undefined;
    const useSparse = sparseAt === index;
    for (let component = 0; component < dimensions; component++) {
      const value = useSparse
        ? scalar(
            values!,
            (sparse!.values.byteOffset ?? 0) +
              sparseIndex * elementSize +
              component * width,
            accessor.componentType,
          )
        : ordinary
          ? scalar(
              ordinary,
              (accessor.byteOffset ?? 0) + index * stride + component * width,
              accessor.componentType,
            )
          : 0;
      if (!visit(value)) return false;
    }
    if (useSparse) sparseIndex++;
  }
  return true;
}
async function validGeometry(root: Root, buffers: Uint8Array[]) {
  for (const mesh of root.meshes ?? [])
    for (const primitive of mesh.primitives) {
      const draco = primitive.extensions?.KHR_draco_mesh_compression as
        Draco | undefined;
      if (draco) {
        if (
          !integer(draco.bufferView) ||
          !draco.attributes ||
          typeof draco.attributes !== 'object' ||
          Array.isArray(draco.attributes)
        )
          return false;
        const ids = Object.values(draco.attributes);
        if (
          ids.some((id) => !integer(id) || id > 0xffffffff) ||
          !(await decodeDraco(
            viewBytes(root, buffers, draco.bufferView),
            primitive.mode === 0,
            ids,
            {
              decodedBytes: MAX_DECODED_RESOURCE_BYTES,
              points: Math.floor(MAX_DECODED_RESOURCE_BYTES / 12),
              faces: Math.floor(MAX_DECODED_RESOURCE_BYTES / 12),
            },
          ))
        )
          return false;
        continue;
      }
      const position = root.accessors?.[primitive.attributes.POSITION];
      if (!position || position.type !== 'VEC3') return false;
      if (
        position.componentType === 5126 &&
        !accessorValues(root, buffers, position, Number.isFinite)
      )
        return false;
      if (primitive.indices !== undefined) {
        const index = root.accessors?.[primitive.indices];
        if (
          !index ||
          index.type !== 'SCALAR' ||
          index.normalized ||
          ![5121, 5123, 5125].includes(index.componentType) ||
          !accessorValues(
            root,
            buffers,
            index,
            (value) => value < position.count,
          )
        )
          return false;
      }
    }
  return true;
}
async function validImages(root: Root, buffers: Uint8Array[]) {
  const basis = new Set<number>(),
    ordinary = new Set<number>();
  for (const texture of root.textures ?? []) {
    const extension = texture.extensions?.KHR_texture_basisu as
      { source?: number } | undefined;
    if (extension) {
      if (!integer(extension.source)) return false;
      basis.add(extension.source);
    } else if (texture.source !== undefined) ordinary.add(texture.source);
  }
  for (const [index, image] of (root.images ?? []).entries()) {
    if (basis.has(index) && ordinary.has(index)) return false;
    const data = image.uri
      ? dataUri(image.uri)
      : {
          bytes: viewBytes(root, buffers, image.bufferView!),
          mime: image.mimeType!,
        };
    if (image.mimeType && image.mimeType !== data.mime) return false;
    const bytes = data.bytes;
    const isKtx =
      bytes.length >= 12 &&
      [171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10].every(
        (value, index) => bytes[index] === value,
      );
    if (isKtx) {
      if (!basis.has(index) || data.mime !== 'image/ktx2' || bytes.length < 80)
        return false;
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      if (
        BigInt(view.getUint32(20, true)) *
          BigInt(view.getUint32(24, true)) *
          4n >
        BigInt(MAX_DECODED_RESOURCE_BYTES)
      )
        return false;
      const levels = view.getUint32(40, true);
      if (!levels || 80 + levels * 24 > bytes.length) return false;
      for (let level = 0; level < levels; level++)
        if (
          view.getBigUint64(80 + level * 24 + 16, true) >
          BigInt(MAX_DECODED_RESOURCE_BYTES)
        )
          return false;
      if (!(await decodeBasis(bytes, MAX_DECODED_RESOURCE_BYTES))) return false;
    } else if (basis.has(index) || !(await decodeImage(bytes, data.mime)))
      return false;
  }
  return true;
}
export async function validGlb(bytes: Uint8Array) {
  try {
    if (!(await validGlbStructure(bytes))) return false;
    const { root, binary } = parts(bytes);
    const buffers = await loadBuffers(root, binary);
    return (
      (await validGeometry(root, buffers)) && (await validImages(root, buffers))
    );
  } catch {
    return false;
  }
}
