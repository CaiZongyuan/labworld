import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  builtinKinds,
  createBuiltinModel,
} from '../packages/views/src/lab/builtin-models.ts';

const profiles = {};
const rounded = (value) => value.map((number) => Number(number.toFixed(6)));
for (const kind of builtinKinds) {
  const model = createBuiltinModel(kind);
  profiles[kind] = {
    id: `lab.native.v1.${kind}`,
    units: 'm',
    anchor: 'base centre; y=0 support plane',
    bounds: {
      min: rounded(model.bounds.min.toArray()),
      max: rounded(model.bounds.max.toArray()),
      size: rounded(model.bounds.getSize(model.bounds.min.clone()).toArray()),
    },
    worktopHeight: model.worktopHeight,
    meaning:
      kind === 'environment'
        ? 'Existing environment/location marker; no room dimensions or room identity'
        : 'Representation dimensions, not a physical measurement or simulation',
  };
  const geometries = new Set(),
    materials = new Set();
  model.scene.traverse((node) => {
    if (!node.isMesh) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material)
      ? node.material
      : [node.material])
      materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
const output = resolve(
  import.meta.dirname,
  '../packages/contracts/src/lab-representations.ts',
);
const source =
  '// Generated from the native geometry owner. Run pnpm representations:generate.\n' +
  'export const labRepresentationProfiles = ' +
  JSON.stringify(
    {
      format: 1,
      placement: {
        position: 'metres',
        rotation: 'radians',
        scale: 'positive multiplier; original GLB units are retained',
      },
      imported: {
        anchor: 'bounding-box X/Z centre and minimum Y; no rescaling',
      },
      profiles,
    },
    null,
    2,
  ) +
  ' as const;\n';
const text = await format(source, {
  ...(await resolveConfig(output)),
  filepath: output,
});
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== text)
    throw new Error(
      'Native representation metadata drift; run pnpm representations:generate',
    );
  console.log('Verified native metre/bounds/worktop/Placement metadata');
} else {
  writeFileSync(output, text);
  console.log('Generated native metre/bounds/worktop/Placement metadata');
}
