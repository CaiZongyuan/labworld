import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guideProgressApiParts } from '../../scripts/lib/guide-progress-api.ts';
import { semanticDifferences } from '../../scripts/lib/contract-openapi.ts';
const source = JSON.parse(
  readFileSync('packages/contracts/openapi.json', 'utf8'),
);
const baseline = JSON.parse(
  readFileSync('tests/contract/api-baseline.json', 'utf8'),
);
const addition = JSON.parse(
  readFileSync('tests/contract/guide-progress-api.json', 'utf8'),
);
const path = '/api/v1/lab/guides/{guide_id}/{guide_version}/progress';
function differences(document) {
  const parts = guideProgressApiParts(document);
  return [
    ...semanticDifferences(baseline, parts.existing),
    ...semanticDifferences(addition, parts.addition),
  ];
}
test('the two approved progress operations preserve the immutable retained API and reachable schemas', () => {
  assert.deepEqual(differences(source), []);
});
test('changed or removed retained operations and reachable schemas still fail comparison', () => {
  for (const mutate of [
    (doc) => delete doc.paths['/api/v1/lab/labs'].get,
    (doc) => {
      doc.paths['/api/v1/lab/labs'].get.operationId = 'wrongRetainedIdentity';
    },
    (doc) => {
      doc.components.schemas.LabWorld.properties.version.type = 'number';
    },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.ok(differences(changed).length);
  }
});
test('unknown routes methods and renamed approved operations are not allowed additions', () => {
  for (const mutate of [
    (doc) => {
      doc.paths['/api/v1/lab/unknown'] = {
        get: structuredClone(doc.paths[path].get),
      };
    },
    (doc) => {
      doc.paths[path].post = structuredClone(doc.paths[path].put);
    },
    (doc) => {
      doc.paths[path].get.operationId = 'getSomeoneElseGuideProgress';
    },
    (doc) => delete doc.paths[path].put,
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.ok(differences(changed).length);
  }
});
test('guide progress request schemas cannot silently accept owner or committed receipt fields', () => {
  const changed = structuredClone(source);
  changed.components.schemas.SaveLabGuideProgress.properties.actor_id = {
    type: 'string',
  };
  assert.ok(differences(changed).length);
  const context = structuredClone(source);
  context.components.schemas.GuideBusinessAttempt.properties.committed_entity_id =
    { type: 'string' };
  assert.ok(differences(context).length);
});
