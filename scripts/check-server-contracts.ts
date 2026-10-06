import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { semanticDifferences, type Json } from './lib/contract-openapi.ts';
const output = resolve('.scratch/vnext-m1/generated');
function hash(directory: string): string {
  return createHash('sha256')
    .update(
      readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
        .sort()
        .map((p) => p + readFileSync(p, 'utf8'))
        .join('\n'),
    )
    .digest('hex');
}
const official = ['packages/contracts', 'packages/sdk'].map(hash);
execFileSync(
  process.execPath,
  ['scripts/generate-contracts.mjs', '--source', 'server', '--output', output],
  { stdio: 'inherit' },
);
const baseline = JSON.parse(
  readFileSync('tests/contract/api-baseline.json', 'utf8'),
) as Record<string, Json>;
const partial = JSON.parse(
  readFileSync(join(output, 'packages/contracts/openapi.json'), 'utf8'),
) as Record<string, Json>;
const paths = ['/health/live', '/health/ready', '/api/v1/system/status'];
const schemas = [
  'ApiError',
  'ApiErrorResponse',
  'HealthResponse',
  'SystemStatus',
];
function project(document: Record<string, Json>): Json {
  const sourcePaths = document.paths as Record<string, Json>;
  const sourceSchemas = (document.components as Record<string, Json>)
    .schemas as Record<string, Json>;
  return {
    paths: Object.fromEntries(paths.map((path) => [path, sourcePaths[path]])),
    components: {
      schemas: Object.fromEntries(
        schemas.map((name) => [name, sourceSchemas[name]]),
      ),
    },
  };
}
const differences = semanticDifferences(project(baseline), project(partial));
if (differences.length)
  throw new Error(`Migrated foundation API drift: ${differences.join(', ')}`);
for (const mutate of [
  (x: Record<string, Json>) => {
    (x.paths as Record<string, Record<string, Record<string, Json>>>)[
      paths[0]
    ].get.operationId = 'changed';
  },
  (x: Record<string, Json>) => {
    (
      (x.components as Record<string, Json>).schemas as Record<string, Json>
    ).ApiError = { type: 'string' };
  },
]) {
  const changed = structuredClone(partial);
  mutate(changed);
  if (!semanticDifferences(project(baseline), project(changed)).length)
    throw new Error('Scoped contract oracle failed to detect mutation');
}
if (
  official.some(
    (before, index) =>
      before !== hash(['packages/contracts', 'packages/sdk'][index]),
  )
)
  throw new Error('Partial generation changed complete SDK/contracts');
const consumer = join(output, 'consumer.ts');
writeFileSync(
  consumer,
  "import {getLiveness,getReadiness,getSystemStatus} from './packages/sdk/src/generated/sdk.gen';\nvoid getLiveness(); void getReadiness(); void getSystemStatus();\n",
);
execFileSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '--moduleResolution',
    'bundler',
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--skipLibCheck',
    consumer,
  ],
  { stdio: 'inherit' },
);
mkdirSync('.scratch/vnext-m1', { recursive: true });
writeFileSync(
  '.scratch/vnext-m1/contracts-result.json',
  JSON.stringify(
    {
      status: 'passed',
      scope: paths,
      semanticDifferences: differences,
      officialConsumersUnchanged: true,
      generatedCallerTypechecked: true,
      fullApi: 'pending M5',
    },
    null,
    2,
  ),
);
console.log(
  'Isolated Zod/OpenAPI/SDK generation and three migrated endpoint contracts verified; full API pending M5.',
);
