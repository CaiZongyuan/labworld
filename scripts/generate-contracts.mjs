import { createClient } from '@hey-api/openapi-ts';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const checking = process.argv.includes('--check');
const source = process.argv.includes('--source')
  ? process.argv[process.argv.indexOf('--source') + 1]
  : 'rust';
if (!['rust', 'server'].includes(source))
  throw new Error('Contract source must be rust or server');
const isolated = source === 'server';
if (isolated && !process.argv.includes('--output'))
  throw new Error('Partial server generation requires --output isolation');
const outputRoot = isolated
  ? resolve(process.argv[process.argv.indexOf('--output') + 1])
  : root;
if (isolated && outputRoot === root)
  throw new Error('Partial server output cannot overwrite the complete SDK');
function physicalPath(path) {
  const suffix = [];
  let ancestor = path;
  while (!existsSync(ancestor)) {
    suffix.unshift(relative(dirname(ancestor), ancestor));
    ancestor = dirname(ancestor);
  }
  return resolve(realpathSync(ancestor), ...suffix);
}
const protectedRoots = ['packages/contracts', 'packages/sdk'].map((path) =>
  physicalPath(join(root, path)),
);
function assertIsolated(path) {
  const physical = physicalPath(path);
  if (
    isolated &&
    protectedRoots.some(
      (directory) =>
        physical === directory || physical.startsWith(directory + sep),
    )
  )
    throw new Error('Partial output overlaps official consumers');
}
const temporary = mkdtempSync(join(tmpdir(), 'labos-threejs-contracts-'));
const files = new Map();

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path) : [path];
  });
}

try {
  const contract = isolated
    ? execFileSync(
        process.execPath,
        ['--experimental-strip-types', 'apps/server/src/openapi.ts'],
        { cwd: root, encoding: 'utf8' },
      )
    : execFileSync(
        'cargo',
        [
          'run',
          '--quiet',
          '--locked',
          '-p',
          'labos-threejs-api',
          '--bin',
          'openapi',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4',
          },
        },
      );
  JSON.parse(contract);
  const input = join(temporary, 'openapi.json');
  writeFileSync(input, contract);
  const generated = join(temporary, 'generated');
  await createClient({
    input,
    output: generated,
    plugins: ['@hey-api/typescript', '@hey-api/sdk', '@hey-api/client-fetch'],
  });
  files.set('packages/contracts/openapi.json', contract);
  for (const path of collect(generated)) {
    const local = relative(generated, path).split(sep).join('/');
    if (local === 'types.gen.ts') {
      files.set(
        'packages/contracts/src/generated/types.gen.ts',
        readFileSync(path, 'utf8'),
      );
      files.set(
        'packages/sdk/src/generated/types.gen.ts',
        isolated
          ? '// Isolated M1 contract bridge.\nexport type * from "../../../contracts/src/generated/types.gen";\n'
          : '// Generated contract bridge. Run pnpm generate.\nexport type * from "@labos-threejs/contracts";\n',
      );
    } else {
      files.set(
        `packages/sdk/src/generated/${local}`,
        readFileSync(path, 'utf8'),
      );
    }
  }
  for (const path of files.keys()) assertIsolated(join(outputRoot, path));
  const drift = [];
  for (const [path, content] of files) {
    const absolute = join(outputRoot, path);
    if (checking) {
      let current;
      try {
        current = readFileSync(absolute, 'utf8');
      } catch {
        current = undefined;
      }
      if (current !== content) drift.push(path);
    } else {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
  }
  for (const directory of [
    'packages/contracts/src/generated',
    'packages/sdk/src/generated',
  ]) {
    const absolute = join(outputRoot, directory);
    assertIsolated(absolute);
    if (!existsSync(absolute)) continue;
    for (const path of collect(absolute)) {
      const local = relative(outputRoot, path).split(sep).join('/');
      if (!files.has(local)) {
        if (checking) drift.push(local);
        else rmSync(path);
      }
    }
  }
  if (drift.length)
    throw new Error(`Contract drift: ${drift.join(', ')}. Run pnpm generate.`);
  console.log(
    `${checking ? 'Verified' : 'Generated'} OpenAPI, TypeScript contracts and SDK (${files.size} files; ${source} source${isolated ? '; isolated partial output' : ''}).`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
