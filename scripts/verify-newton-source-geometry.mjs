import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const [scene, manifestFile, reportFile] = process.argv.slice(2);
assert.ok(
  scene && manifestFile && reportFile,
  'Provide source USD, manifest and owned report path.',
);
const python = process.env.LAB_WORLD_SOURCE_PYTHON;
assert.ok(
  python,
  'Set LAB_WORLD_SOURCE_PYTHON to the existing USD-capable environment.',
);
const witnessFile = reportFile + '.usd-witness.json';
const witness = spawnSync(
  python,
  [
    '-B',
    fileURLToPath(
      new URL(
        '../tests/support/newton-source-geometry-witness.py',
        import.meta.url,
      ),
    ),
    scene,
    manifestFile,
    witnessFile,
  ],
  { encoding: 'utf8' },
);
assert.equal(witness.status, 0, witness.stderr);
const expected = JSON.parse(await readFile(witnessFile, 'utf8'));
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const require = createRequire(
  new URL('../packages/views/package.json', import.meta.url),
);
const base = dirname(require.resolve('three'));
const { GLTFLoader } = await import(
  pathToFileURL(join(base, '../examples/jsm/loaders/GLTFLoader.js')).href
);
const { Vector3 } = await import(
  pathToFileURL(join(base, 'three.module.js')).href
);
const actual = new Map();
for (const resource of manifest.resources.filter(
  (r) => r.content_type === 'model/gltf-binary',
)) {
  const bytes = await readFile(join(dirname(manifestFile), resource.path));
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    let ancestor = mesh;
    while (ancestor && !ancestor.userData.labworld_source_path)
      ancestor = ancestor.parent;
    assert.ok(
      ancestor,
      'Exported mesh must retain its original full source path.',
    );
    const path = ancestor.userData.labworld_source_path;
    const positions = mesh.geometry.getAttribute('position');
    const points = actual.get(path) ?? [];
    for (let i = 0; i < positions.count; i++) {
      const p = new Vector3()
        .fromBufferAttribute(positions, i)
        .applyMatrix4(mesh.matrixWorld);
      points.push([p.x, p.y, p.z]);
    }
    actual.set(path, points);
  });
}
assert.deepEqual(
  [...actual.keys()].sort(),
  Object.keys(expected.meshes).sort(),
  'Visible source mesh coverage differs.',
);
const tolerance = 0.000005;
const bin = (p) => p.map((v) => Math.floor(v / tolerance));
function lookup(points) {
  const result = new Map();
  for (const p of points) {
    const k = bin(p).join(',');
    const values = result.get(k) ?? [];
    if (!values.some((v) => v.every((x, i) => x === p[i]))) values.push(p);
    result.set(k, values);
  }
  return result;
}
function contains(index, point) {
  const key = bin(point);
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++) {
        const values =
          index.get([key[0] + x, key[1] + y, key[2] + z].join(',')) ?? [];
        if (
          values.some((v) =>
            v.every((value, i) => Math.abs(value - point[i]) <= tolerance),
          )
        )
          return true;
      }
  return false;
}
const checks = [];
for (const [path, wanted] of Object.entries(expected.meshes)) {
  const data = inflateSync(
    Buffer.from(wanted.points_f32_zlib_base64, 'base64'),
  );
  const points = [];
  for (let i = 0; i < data.length; i += 12)
    points.push([
      data.readFloatLE(i),
      data.readFloatLE(i + 4),
      data.readFloatLE(i + 8),
    ]);
  const received = actual.get(path);
  const expectedIndex = lookup(points),
    actualIndex = lookup(received);
  assert.ok(
    points.every((p) => contains(actualIndex, p)),
    `Source vertices missing or moved: ${path}`,
  );
  assert.ok(
    received.every((p) => contains(expectedIndex, p)),
    `Unexpected exported vertices: ${path}`,
  );
  checks.push({
    path,
    source_unique_vertices: points.length,
    decoded_vertices: received.length,
    tolerance_m: tolerance,
  });
}
const report = {
  status: 'passed',
  reader: 'Three GLTFLoader versus independent USD geometry API',
  meshes: checks,
  source_hierarchy_classification: expected.source_hierarchy_classification,
};
await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: report.status,
    meshes: checks.length,
    classification: report.source_hierarchy_classification,
  }),
);
