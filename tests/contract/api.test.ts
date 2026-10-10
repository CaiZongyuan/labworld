import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  retainedOpenApi,
  semanticDifferences,
  type Json,
} from '../../scripts/lib/contract-openapi';
import { guideProgressApiParts } from '../../scripts/lib/guide-progress-api';
import { motionApiParts } from '../../scripts/lib/motion-api';
import { HttpClient } from './http';
const baseline = JSON.parse(
  readFileSync('tests/contract/api-baseline.json', 'utf8'),
) as Json;
const addition = JSON.parse(
  readFileSync('tests/contract/guide-progress-api.json', 'utf8'),
) as Json;
// Issue #70 approves only these exact fixture operations and their reachable schemas.
const motionAddition = JSON.parse(
  readFileSync('tests/contract/motion-api.json', 'utf8'),
) as Json;
function differences(document: Json) {
  const motion = motionApiParts(document);
  const parts = guideProgressApiParts(motion.existing);
  return [
    ...semanticDifferences(baseline, parts.existing),
    ...semanticDifferences(addition, parts.addition),
    ...semanticDifferences(motionAddition, motion.addition),
  ];
}
test('API-01 retained Rust OpenAPI and approved guide/motion additions have no drift; DTO,operation,status,error,security changes are detected', async () => {
  const source = await new HttpClient().json<Json>('GET', '/api/openapi.json');
  const retained = retainedOpenApi(source);
  expect(differences(retained)).toEqual([]);
  const serialized = JSON.stringify(retained);
  for (const removed of [
    'listJobs',
    'getCacheStatus',
    'listNotifications',
    'requestPasswordReset',
    'listKnowledgeBases',
  ])
    expect(serialized).not.toContain(removed);
  const raw = retained as Record<string, Json>;
  const paths = raw.paths as Record<
    string,
    Record<string, Record<string, Json>>
  >;
  expect(paths['/api/v1/lab/labs']).toBeDefined();
  const changed = structuredClone(retained) as typeof raw;
  (changed.paths as typeof paths)['/api/v1/lab/labs'].post.operationId =
    'createDifferentLab';
  expect(differences(changed)).toContain(
    '/paths/~1api~1v1~1lab~1labs/post/operationId',
  );
  const cases: Array<(api: typeof raw) => void> = [
    (api) => {
      (
        (api.components as Record<string, Json>).schemas as Record<string, Json>
      ).LabEntity = { type: 'string' };
    },
    (api) => {
      delete (
        (api.paths as typeof paths)['/api/v1/lab/labs'].post
          .responses as Record<string, Json>
      )['201'];
    },
    (api) => {
      (api.paths as typeof paths)['/api/v1/lab/labs'].post.security = [
        { newUnreviewedSecurity: [] },
      ];
      (api.components as Record<string, Json>).securitySchemes = {
        newUnreviewedSecurity: {
          type: 'apiKey',
          in: 'header',
          name: 'x-unreviewed-key',
        },
      };
    },
    (api) => {
      (
        (api.components as Record<string, Json>).schemas as Record<string, Json>
      ).ApiErrorResponse = { type: 'string' };
    },
    (api) => {
      delete (api.paths as typeof paths)['/api/v1/lab/labs'].post;
    },
    (api) => {
      (api.paths as typeof paths)['/api/v1/lab/labs'].trace = structuredClone(
        paths['/api/v1/lab/labs'].post,
      );
    },
    (api) => {
      (api.paths as typeof paths)['/api/v1/lab/unknown'] = {
        get: structuredClone(paths['/api/v1/lab/labs'].get),
      };
    },
  ];
  const progress = '/api/v1/lab/guides/{guide_id}/{guide_version}/progress';
  cases.push(
    (api) => {
      (api.paths as typeof paths)[progress].post = structuredClone(
        paths[progress].put,
      );
    },
    (api) => {
      (api.paths as typeof paths)[progress].get.operationId =
        'getSomeoneElseGuideProgress';
    },
    (api) => {
      delete (api.paths as typeof paths)[progress].put;
    },
  );
  const fixture = '/api/v1/lab/labs/{lab_id}/motion-fixture';
  cases.push(
    (api) => {
      (api.paths as typeof paths)[fixture].get.operationId =
        'getUnapprovedFixture';
    },
    (api) => {
      delete (api.paths as typeof paths)[fixture].post;
    },
    (api) => {
      (api.paths as typeof paths)[fixture].put = structuredClone(
        paths[fixture].post,
      );
    },
    (api) => {
      (
        (api.components as Record<string, Json>).schemas as Record<string, Json>
      ).MotionTicket = { type: 'string' };
    },
  );
  for (const mutate of cases) {
    const candidate = structuredClone(retained) as typeof raw;
    mutate(candidate);
    expect(differences(candidate).length).toBeGreaterThan(0);
  }
  for (const keyword of ['example', 'default']) {
    const before = {
      [keyword]: { tags: ['first', 'second'], required: ['left', 'right'] },
    };
    const after = {
      [keyword]: { tags: ['second', 'first'], required: ['left', 'right'] },
    };
    expect(semanticDifferences(before, after)).toEqual([`/${keyword}/tags`]);
  }
  expect(
    semanticDifferences(
      {
        type: 'object',
        required: ['a', 'b'],
        properties: { default: { type: 'string', enum: ['a', 'b'] } },
      },
      {
        type: 'object',
        required: ['b', 'a'],
        properties: { default: { type: 'string', enum: ['b', 'a'] } },
      },
    ),
  ).toEqual([]);
  const reordered = JSON.parse(JSON.stringify(retained), (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  ) as Json;
  expect(differences(reordered)).toEqual([]);
});
