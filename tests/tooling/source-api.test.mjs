import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceApiParts } from '../../scripts/lib/source-api.ts';
import { semanticDifferences } from '../../scripts/lib/contract-openapi.ts';

const base = '/api/v1/lab/labs/{lab_id}/sources';
const source = {
  openapi: '3.1.0',
  info: { title: 'Contract partition fixture', version: '1' },
  paths: {
    [base]: {
      get: {
        operationId: 'listLabSources',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LabSourcePage' },
              },
            },
          },
        },
      },
    },
    '/api/v1/lab/labs': { get: { operationId: 'listLabs' } },
  },
  components: {
    schemas: {
      LabSourcePage: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/LabSource' },
          },
        },
      },
      LabSource: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  },
};

test('source separation retains its complete schema closure and leaves the input unchanged', () => {
  const before = structuredClone(source),
    parts = sourceApiParts(source);
  assert.deepEqual(source, before);
  assert.deepEqual(parts.existing.paths, {
    '/api/v1/lab/labs': { get: { operationId: 'listLabs' } },
  });
  assert.deepEqual(parts.existing.components, {});
  assert.deepEqual(parts.addition.paths, { [base]: source.paths[base] });
  assert.deepEqual(parts.addition.components, source.components);
});

test('renamed source operations, unknown methods and new source subroutes remain retained drift', () => {
  const expected = sourceApiParts(source).existing;
  for (const mutate of [
    (doc) => {
      doc.paths[base].get.operationId = 'listUnauthenticatedSources';
    },
    (doc) => {
      doc.paths[base].put = structuredClone(doc.paths[base].get);
    },
    (doc) => {
      doc.paths[`${base}/{source_id}/unapproved`] = {
        post: structuredClone(doc.paths[base].get),
      };
    },
    (doc) => {
      doc.paths['/api/v1/lab/labs'].get.operationId = 'listOtherLabs';
    },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.ok(
      semanticDifferences(expected, sourceApiParts(changed).existing).length,
    );
  }
});

test('removal and source DTO changes remain visible in the source addition', () => {
  const expected = sourceApiParts(source).addition;
  for (const mutate of [
    (doc) => delete doc.paths[base].get,
    (doc) => {
      doc.components.schemas.LabSource.properties.credential = {
        type: 'string',
      };
    },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.ok(
      semanticDifferences(expected, sourceApiParts(changed).addition).length,
    );
  }
});
