import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  semanticDifferences,
  retainedOpenApi,
  type Json,
} from './lib/contract-openapi.ts';
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
const paths = [
  '/health/live',
  '/health/ready',
  '/api/v1/system/status',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/session',
  '/api/v1/auth/logout',
  '/api/v1/organization/members',
  '/api/v1/organization/members/{user_id}',
  '/api/v1/api-keys',
  '/api/v1/api-keys/{id}',
  '/api/v1/api-keys/scopes',
  '/api/v1/profile',
  '/api/v1/audit-events',
  '/api/v1/system/rate-limits',
];
const fileSchemas = [
  'UploadInput',
  'FileInfo',
  'ObjectCapability',
  'UploadCapability',
  'DownloadCapability',
];
function project(document: Record<string, Json>): Json {
  const sourcePaths = document.paths as Record<string, Json>;
  const projected = retainedOpenApi({
    paths: Object.fromEntries(
      paths.map((path) => {
        if (!sourcePaths[path])
          throw new Error(`Missing migrated Core path: ${path}`);
        return [path, sourcePaths[path]];
      }),
    ),
    components: document.components,
    'x-core-contract-roots': fileSchemas.map((name) => ({
      $ref: `#/components/schemas/${name}`,
    })),
  }) as Record<string, Json>;
  delete projected['x-core-contract-roots'];
  return projected;
}
const differences = semanticDifferences(project(baseline), project(partial));
if (differences.length)
  throw new Error(`Migrated Core API drift: ${differences.join(', ')}`);
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
  (x: Record<string, Json>) => {
    const operations = x.paths as Record<
      string,
      Record<string, { responses: Record<string, Json> }>
    >;
    delete operations['/api/v1/auth/session'].get.responses['401'];
  },
  (x: Record<string, Json>) => {
    const operations = x.paths as Record<
      string,
      Record<string, { parameters: Json[] }>
    >;
    operations['/api/v1/organization/members/{user_id}'].put.parameters = [];
  },
  (x: Record<string, Json>) => {
    const schemas = (x.components as { schemas: Record<string, Json> }).schemas;
    const upload = schemas.UploadCapability as {
      properties: Record<string, Json>;
    };
    upload.properties.upload = {
      $ref: '#/components/schemas/ObjectCapability',
    };
  },
  (x: Record<string, Json>) => {
    const schemas = (x.components as { schemas: Record<string, Json> }).schemas;
    const capability = schemas.ObjectCapability as {
      properties: Record<string, Json>;
    };
    capability.properties.headers = { type: 'string' };
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
  `import * as core from './packages/sdk/src/generated/sdk.gen';
import type {FileInfo,UploadInput,ObjectCapability,UploadCapability,DownloadCapability} from './packages/contracts/src/generated/types.gen';
const input:UploadInput={file_name:'sample.txt',content_type:'text/plain',size:1,sha256:'00'};
const file:FileInfo={id:'file',file_name:input.file_name,content_type:input.content_type,size:input.size,sha256:input.sha256,created_at:'2026-10-07T00:00:00.123456Z',previewable:false};
const request:ObjectCapability={url:'https://example.test/objects/file',method:'GET',headers:{},expires_at:'2026-10-07T00:01:00Z'};
const mutation={headers:{'x-csrf-token':'from-session'}};
const upload:UploadCapability={upload_id:file.id,state:'pending_upload',upload:null};
const download:DownloadCapability={...request,file};void upload;void download;
void core.getLiveness();void core.getReadiness();void core.getSystemStatus();void core.getRateLimitStatus();
void core.registerUser({body:{email:'reader@example.test',password:'example-long-password'}});
void core.loginUser({body:{email:'reader@example.test',password:'example-long-password'}});void core.getCurrentSession();void core.logoutUser(mutation);void core.getProfile();
void core.listMembers({query:{limit:1}});void core.updateMember({...mutation,path:{user_id:'user'},body:{role:'member',active:true,version:1}});
void core.listApiKeys({query:{limit:1}});void core.createApiKey({...mutation,body:{name:'Example',scopes:['lab:full'],expires_in_days:1}});void core.listApiKeyScopes();void core.revokeApiKey({...mutation,path:{id:'key'}});
void core.listAuditEvents({query:{limit:1,actor_id:'user',action:'identity.register'}});
`,
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
      recursiveSchemas: Object.keys(
        (
          (project(partial) as Record<string, Json>).components as Record<
            string,
            Json
          >
        ).schemas as Record<string, Json>,
      ).sort(),
      securitySchemes: Object.keys(
        ((
          (project(partial) as Record<string, Json>).components as Record<
            string,
            Json
          >
        ).securitySchemes ?? {}) as Record<string, Json>,
      ).sort(),
      fileSchemas,
      officialConsumersUnchanged: true,
      generatedCallerTypechecked: true,
      fullApi: 'pending M5',
    },
    null,
    2,
  ),
);
console.log(
  'Isolated recursive Core routes/file DTOs and representative SDK caller verified; full Lab API pending M5.',
);
