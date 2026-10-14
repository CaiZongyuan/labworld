import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetVersionApiParts } from '../../scripts/lib/asset-version-api.ts';
import { semanticDifferences } from '../../scripts/lib/contract-openapi.ts';

const source = {
  openapi: '3.1.0',
  paths: {
    '/api/v1/lab/definitions': {
      get: {
        operationId: 'listLabDefinitions',
        responses: {
          200: { schema: { $ref: '#/components/schemas/AssetDefinition' } },
        },
      },
    },
    '/api/v1/lab/asset-versions': {
      post: {
        operationId: 'importCompleteAssetVersion',
        responses: {
          201: {
            schema: { $ref: '#/components/schemas/CompleteAssetVersion' },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      AssetDefinition: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          asset_version: { $ref: '#/components/schemas/CompleteAssetVersion' },
        },
      },
      CompleteAssetVersion: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    },
  },
};

test('the generated asset version API matches seven approved operations and the complete definition extension', () => {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8')),
    actual = assetVersionApiParts(
      read('packages/contracts/openapi.json'),
    ).addition;
  assert.deepEqual(
    semanticDifferences(read('tests/contract/asset-version-api.json'), actual),
    [],
  );
  assert.equal(Object.keys(actual.paths).length, 6);
  assert.equal(Object.values(actual.paths).flatMap(Object.keys).length, 7);
  assert.ok(actual['x-asset-definition-version']);
});

test('only the optional asset version field leaves the unchanged definition closure', () => {
  const original = structuredClone(source),
    parts = assetVersionApiParts(source);
  assert.deepEqual(source, original);
  assert.deepEqual(parts.existing.components.schemas.AssetDefinition, {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  });
  assert.equal(
    parts.existing.components.schemas.CompleteAssetVersion,
    undefined,
  );
  assert.deepEqual(parts.addition['x-asset-definition-version'], {
    $ref: '#/components/schemas/CompleteAssetVersion',
  });
  assert.deepEqual(
    parts.addition.components.schemas.CompleteAssetVersion,
    source.components.schemas.CompleteAssetVersion,
  );
});

test('required asset version fields and unrelated definition changes remain retained drift', () => {
  const expected = assetVersionApiParts(source).existing;
  for (const mutate of [
    (doc) =>
      doc.components.schemas.AssetDefinition.required.push('asset_version'),
    (doc) => {
      doc.components.schemas.AssetDefinition.properties.name.type = 'number';
    },
    (doc) => {
      doc.components.schemas.AssetDefinition.properties.unapproved = {
        type: 'string',
      };
    },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.ok(
      semanticDifferences(expected, assetVersionApiParts(changed).existing)
        .length,
    );
  }
});

test('removing the version field or changing the full version schema remains addition drift', () => {
  const expected = assetVersionApiParts(source).addition;
  for (const mutate of [
    (doc) =>
      delete doc.components.schemas.AssetDefinition.properties.asset_version,
    (doc) => {
      doc.components.schemas.CompleteAssetVersion.properties.id.type = 'number';
    },
    (doc) => delete doc.paths['/api/v1/lab/asset-versions'].post,
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.ok(
      semanticDifferences(expected, assetVersionApiParts(changed).addition)
        .length,
    );
  }
});
