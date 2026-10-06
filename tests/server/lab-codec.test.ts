import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decodeDraco,
  decodeImage,
} from '../../packages/server/src/platform/codecs.ts';

type Glb = {
  bufferViews: { byteOffset?: number; byteLength: number }[];
  meshes: {
    primitives: {
      extensions: {
        KHR_draco_mesh_compression: {
          bufferView: number;
          attributes: Record<string, number>;
        };
      };
    }[];
  }[];
  images: { bufferView: number }[];
};
function payload(bytes: Buffer, index: (root: Glb) => number) {
  const jsonLength = bytes.readUInt32LE(12);
  const root = JSON.parse(
    bytes.subarray(20, 20 + jsonLength).toString('utf8'),
  ) as Glb;
  const view = root.bufferViews[index(root)];
  const start = 28 + jsonLength + (view.byteOffset ?? 0);
  return { root, bytes: bytes.subarray(start, start + view.byteLength) };
}
test('the native Draco binding applies decoded attribute limits before the same valid payload is decoded', async () => {
  const encoded = await readFile(
    new URL('../fixtures/lab/cube-draco.glb', import.meta.url),
  );
  const data = payload(
    encoded,
    (root) =>
      root.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression
        .bufferView,
  );
  const ids = Object.values(
    data.root.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression
      .attributes,
  );
  const limits = { decodedBytes: 268435456, points: 22369621, faces: 22369621 };
  assert.equal(await decodeDraco(data.bytes, false, ids, limits), true);
  assert.equal(
    await decodeDraco(data.bytes, false, ids, { ...limits, decodedBytes: 1 }),
    false,
  );
  assert.equal(
    await decodeDraco(data.bytes, false, ids, { ...limits, faces: 0 }),
    false,
  );
  assert.equal(
    await decodeDraco(data.bytes, false, [0xffffffff], limits),
    false,
  );
  assert.equal(await decodeDraco(data.bytes, false, ids, limits), true);
});
import { crc32, corruptPngPixelStream } from '../support/png-fixture.ts';
test('a valid PNG header and recomputed IDAT CRC cannot hide a malformed pixel stream', async () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
  const original = await readFile(
    new URL(
      '../../apps/web/public/lab-assets/hdr/studio-thumbnail.png',
      import.meta.url,
    ),
  );
  assert.equal(await decodeImage(original, 'image/png'), true);
  const bad = corruptPngPixelStream(original);
  assert.deepEqual(bad.subarray(0, 33), original.subarray(0, 33));
  assert.equal(await decodeImage(bad, 'image/png'), false);
  assert.equal(await decodeImage(original, 'image/png'), true);
});

test('tiny native point-cloud headers cannot widen the retained positive or signed point ceiling', async () => {
  const limits = { decodedBytes: 268435456, points: 22369621, faces: 22369621 };
  for (const method of [0, 1]) {
    // draco-core 2.2.1 point_cloud_decoder.rs: header followed by a fixed signed
    // int32 point count and zero attribute decoders. No attribute array is allocated.
    const encoded = Buffer.alloc(16);
    encoded.write('DRACO');
    encoded[5] = 2;
    encoded[6] = 3;
    encoded[7] = 0;
    encoded[8] = method;
    encoded.writeUInt32LE(22369621, 11);
    assert.equal(await decodeDraco(encoded, true, [], limits), true);
    encoded.writeUInt32LE(22369622, 11);
    assert.equal(await decodeDraco(encoded, true, [], limits), false);
    assert.equal(
      await decodeDraco(encoded, true, [], { ...limits, points: 22369622 }),
      true,
    );
    encoded.writeInt32LE(-1, 11);
    assert.equal(
      await decodeDraco(encoded, true, [], { ...limits, points: 0xffffffff }),
      false,
    );
  }
});
