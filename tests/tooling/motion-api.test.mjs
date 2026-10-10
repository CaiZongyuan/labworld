import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { motionApiParts } from '../../scripts/lib/motion-api.ts';
import { guideProgressApiParts } from '../../scripts/lib/guide-progress-api.ts';
import { semanticDifferences } from '../../scripts/lib/contract-openapi.ts';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const source = read('packages/contracts/openapi.json');
const baseline = read('tests/contract/api-baseline.json');
const motionBaseline = read('tests/contract/motion-api.json');
const progressBaseline = read('tests/contract/guide-progress-api.json');
const path = '/api/v1/lab/labs/{lab_id}/motion-fixture';
function differences(document) {
  const motion = motionApiParts(document);
  const progress = guideProgressApiParts(motion.existing);
  return [
    ...semanticDifferences(baseline, progress.existing),
    ...semanticDifferences(progressBaseline, progress.addition),
    ...semanticDifferences(motionBaseline, motion.addition),
  ];
}
test('only approved motion HTTP operations extend the preserved API', () =>
  assert.deepEqual(differences(source), []));
test('motion API changes, unknown methods and retained API changes remain visible', () => {
  for (const mutate of [
    (doc) => delete doc.paths[path].post,
    (doc) => {
      doc.paths[path].get.operationId = 'getUnauthenticatedMotion';
    },
    (doc) => {
      doc.paths[path].put = structuredClone(doc.paths[path].post);
    },
    (doc) => {
      doc.paths['/api/v1/lab/unknown'] = {
        get: structuredClone(doc.paths[path].get),
      };
    },
    (doc) => {
      doc.components.schemas.RequestMotionTicket.properties.preferred_rate_hz.anyOf[0].const = 60;
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
