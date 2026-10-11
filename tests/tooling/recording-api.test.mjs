import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordingApiParts } from '../../scripts/lib/recording-api.ts';
import { sessionApiParts } from '../../scripts/lib/session-api.ts';
import { motionApiParts } from '../../scripts/lib/motion-api.ts';
import { guideProgressApiParts } from '../../scripts/lib/guide-progress-api.ts';
import { semanticDifferences } from '../../scripts/lib/contract-openapi.ts';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const source = read('packages/contracts/openapi.json');
const baseline = read('tests/contract/api-baseline.json');
const progressBaseline = read('tests/contract/guide-progress-api.json');
const motionBaseline = read('tests/contract/motion-api.json');
const sessionBaseline = read('tests/contract/session-api.json');
const recordingBaseline = read('tests/contract/recording-api.json');
const base = '/api/v1/lab/labs/{lab_id}/recordings';
const admissionFields = (doc) =>
  doc.components.schemas.PublisherAdmission.allOf.find(
    (part) => part.type === 'object',
  );

function differences(document) {
  const recordings = recordingApiParts(document);
  const sessions = sessionApiParts(recordings.existing);
  const motion = motionApiParts(sessions.existing);
  const progress = guideProgressApiParts(motion.existing);
  return [
    ...semanticDifferences(baseline, progress.existing),
    ...semanticDifferences(progressBaseline, progress.addition),
    ...semanticDifferences(motionBaseline, motion.addition),
    ...semanticDifferences(sessionBaseline, sessions.addition),
    ...semanticDifferences(recordingBaseline, recordings.addition),
  ];
}

test('approved Recording routes and optional admission preserve all immutable API partitions', () => {
  assert.deepEqual(differences(source), []);
  const recordings = recordingApiParts(source);
  assert.equal(Object.keys(recordings.addition.paths).length, 6);
  assert.equal(
    Object.values(recordings.addition.paths).flatMap(Object.keys).length,
    7,
  );
  assert.deepEqual(
    recordings.addition.components.schemas.PublisherAdmission.properties
      .recording,
    admissionFields(source).properties.recording,
  );
  assert.ok(admissionFields(source).properties.recording);
  assert.ok(!admissionFields(source).required.includes('recording'));
  const reordered = structuredClone(source);
  reordered.components.schemas.PublisherAdmission.allOf.reverse();
  assert.deepEqual(differences(reordered), []);
});

test('unapproved Recording paths, methods and operation identities remain semantic drift', () => {
  for (const mutate of [
    (doc) => {
      doc.paths[base + '/future'] = {
        get: structuredClone(doc.paths[base].get),
      };
    },
    (doc) => {
      doc.paths[base].post = structuredClone(doc.paths[base].get);
    },
    (doc) => {
      doc.paths[base].get.operationId = 'listUnapprovedRecordings';
    },
    (doc) => delete doc.paths[base + '/{recording_id}'].delete,
  ]) {
    const candidate = structuredClone(source);
    mutate(candidate);
    assert.ok(differences(candidate).length);
  }
});

test('the approved admission field does not hide other Session or Recording schema changes', () => {
  for (const mutate of [
    (doc) => {
      admissionFields(doc).properties.unreviewed_capability = {
        type: 'string',
      };
    },
    (doc) => {
      admissionFields(doc).required.push('recording');
    },
    (doc) => delete admissionFields(doc).properties.recording,
    (doc) => {
      admissionFields(doc).properties.recording.properties.unreviewed = {
        type: 'string',
      };
    },
    (doc) => {
      doc.components.schemas.PublisherBootstrap.properties.snapshot_hash.type =
        'number';
    },
    (doc) => {
      doc.components.schemas.RecordingEvent.properties.event_type.type =
        'number';
    },
    (doc) => {
      doc.components.schemas.ApiErrorResponse = { type: 'string' };
    },
  ]) {
    const candidate = structuredClone(source);
    mutate(candidate);
    assert.ok(differences(candidate).length);
  }
});

test('only the optional admission field dependency leaves the unchanged Session schema closure', () => {
  const candidate = structuredClone(source);
  const recording = admissionFields(candidate).properties.recording;
  candidate.components.schemas.RecordingAdmissionBootstrap = recording;
  admissionFields(candidate).properties.recording = {
    $ref: '#/components/schemas/RecordingAdmissionBootstrap',
  };
  const recordings = recordingApiParts(candidate);
  const sessions = sessionApiParts(recordings.existing);
  assert.deepEqual(semanticDifferences(sessionBaseline, sessions.addition), []);
  assert.deepEqual(
    recordings.addition.components.schemas.RecordingAdmissionBootstrap,
    recording,
  );
  assert.equal(
    sessions.addition.components.schemas.RecordingAdmissionBootstrap,
    undefined,
  );
  candidate.components.schemas.RecordingAdmissionBootstrap.properties.unreviewed_capability =
    { type: 'string' };
  assert.deepEqual(
    semanticDifferences(
      recordings.addition,
      recordingApiParts(candidate).addition,
    ),
    [
      '/components/schemas/RecordingAdmissionBootstrap/properties/unreviewed_capability',
    ],
  );
});
