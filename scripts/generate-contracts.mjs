import { createClient } from '@hey-api/openapi-ts';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const checking = process.argv.includes('--check');
const temporary = mkdtempSync(join(tmpdir(), 'labos-threejs-contracts-'));
const files = new Map();

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path) : [path];
  });
}

try {
  const contract = execFileSync(
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
    const local = relative(generated, path);
    if (local === 'types.gen.ts') {
      files.set(
        'packages/contracts/src/generated/types.gen.ts',
        readFileSync(path, 'utf8'),
      );
      files.set(
        'packages/sdk/src/generated/types.gen.ts',
        '// Generated contract bridge. Run pnpm generate.\nexport type * from "@labos-threejs/contracts";\n',
      );
    } else {
      files.set(
        `packages/sdk/src/generated/${local}`,
        readFileSync(path, 'utf8'),
      );
    }
  }
  const drift = [];
  for (const [path, content] of files) {
    const absolute = join(root, path);
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
    const absolute = join(root, directory);
    if (!existsSync(absolute)) continue;
    for (const path of collect(absolute)) {
      const local = relative(root, path);
      if (!files.has(local)) {
        if (checking) drift.push(local);
        else rmSync(path);
      }
    }
  }
  if (drift.length)
    throw new Error(`Contract drift: ${drift.join(', ')}. Run pnpm generate.`);
  console.log(
    `${checking ? 'Verified' : 'Generated'} OpenAPI, TypeScript contracts and SDK (${files.size} files).`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
