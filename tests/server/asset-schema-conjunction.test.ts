import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerProcess } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';

function description(
  asset_id: string,
  version: string,
  configuration_schema: object,
) {
  return {
    schema_version: 1,
    asset_id,
    version,
    name: 'Constrained asset',
    category: 'instrument',
    source: 'Contract fixture',
    license: 'CC0',
    specifications: {},
    configuration_schema,
    state_schema: { type: 'object', properties: {} },
    capabilities: [],
    resources: [],
    representations: [],
  };
}
const valueSchema = (rule: object) => ({
  type: 'object',
  properties: { value: rule },
  required: ['value'],
  additionalProperties: false,
});

test('enum and const remain conjunctive with type and scalar bounds at all three public instance mutations', async () => {
  const target = await new ServerProcess().create();
  target.env = { APP_ORIGIN: target.url, FILE_PUBLIC_ORIGIN: target.url };
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('schema-intersection@example.test');
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Schema intersections' },
      201,
    );
    const entities = `/api/v1/lab/labs/${lab.id}/entities`;
    for (const [key, rule, invalidValues, good] of [
      [
        'integer-enum-max',
        { type: 'integer', enum: [1, 20], maximum: 10 },
        [20, 2],
        1,
      ],
      [
        'number-enum-type',
        { type: 'number', enum: ['admin', 1] },
        ['admin', 2],
        1,
      ],
      [
        'string-enum-length',
        { type: 'string', enum: ['a', 'abc'], minLength: 3, maxLength: 3 },
        ['a', 'xyz'],
        'abc',
      ],
      [
        'string-enum-codepoints-min',
        { type: 'string', enum: ['🧪', 'ab'], minLength: 2, maxLength: 2 },
        ['🧪', 'xy'],
        'ab',
      ],
      [
        'string-enum-codepoints-max',
        { type: 'string', enum: ['🧪', 'ab'], minLength: 1, maxLength: 1 },
        ['ab', 'z'],
        '🧪',
      ],
      [
        'const-enum-max',
        { type: 'number', enum: [1, 2, 20], const: 1, maximum: 10 },
        [20, 2],
        1,
      ],
    ] as const) {
      const asset_id = `repair/${key}`;
      const schema = valueSchema(rule);
      await member.json(
        'POST',
        '/api/v1/lab/asset-versions',
        description(asset_id, '1.0', schema),
        201,
      );
      const registration = {
        name: key,
        definition_id: asset_id,
        definition_version: '1.0',
        reality: 'simulated',
        configuration: { value: good },
      };
      for (const bad of invalidValues)
        await member.error(
          'POST',
          entities,
          { ...registration, configuration: { value: bad } },
          400,
          'lab.invalid_input',
        );
      const entity = await member.json<{
        id: string;
        configuration: unknown;
        definition_version: string;
      }>(
        'POST',
        entities,
        { ...registration, configuration: { value: good } },
        201,
      );
      const path = entities + '/' + entity.id;
      for (const bad of invalidValues)
        await member.error(
          'PATCH',
          path,
          { name: key, configuration: { value: bad } },
          400,
          'lab.invalid_input',
        );
      await member.json(
        'POST',
        '/api/v1/lab/asset-versions',
        description(asset_id, '2.0', schema),
        201,
      );
      for (const bad of invalidValues)
        await member.error(
          'PUT',
          path + '/definition',
          {
            definition_id: asset_id,
            definition_version: '2.0',
            configuration: { value: bad },
          },
          400,
          'lab.invalid_input',
        );
      const unchanged = await member.json<typeof entity>('GET', path);
      assert.deepEqual(unchanged.configuration, { value: good });
      assert.equal(unchanged.definition_version, '1.0');
      await member.json('PATCH', path, {
        name: key,
        configuration: { value: good },
      });
      const adopted = await member.json<typeof entity>(
        'PUT',
        path + '/definition',
        {
          definition_id: asset_id,
          definition_version: '2.0',
          configuration: { value: good },
        },
      );
      assert.equal(adopted.definition_version, '2.0');
      assert.deepEqual(adopted.configuration, { value: good });
    }
    const impossible = description(
      'repair/const-outside-range',
      '1.0',
      valueSchema({ type: 'number', const: 20, maximum: 10 }),
    );
    await member.json('POST', '/api/v1/lab/asset-versions', impossible, 201);
    await member.error(
      'POST',
      entities,
      {
        name: 'Impossible constant',
        definition_id: 'repair/const-outside-range',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: { value: 20 },
      },
      400,
      'lab.invalid_input',
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'schema-conjunction.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('nested object and array enum/const honor properties, required, items, lengths and default annotations', async () => {
  const target = await new ServerProcess().create();
  target.env = { APP_ORIGIN: target.url, FILE_PUBLIC_ORIGIN: target.url };
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('nested-schema@example.test');
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Nested schema intersections' },
      201,
    );
    const entities = `/api/v1/lab/labs/${lab.id}/entities`;
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['limits', 'payload', 'code'],
      properties: {
        limits: {
          type: 'array',
          enum: [[1, 2], [1, 20], [1]],
          const: [1, 2],
          minItems: 2,
          maxItems: 2,
          items: { type: 'integer', enum: [1, 2, 20], minimum: 1, maximum: 10 },
        },
        payload: {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'range'],
          enum: [
            { mode: 'ok', range: { width: 2 } },
            { mode: 'ok', range: {} },
            { mode: 'ok', range: { width: 20 } },
            { mode: 'ok', range: { width: 2 }, extra: true },
          ],
          const: { mode: 'ok', range: { width: 2 } },
          properties: {
            mode: { type: 'string', const: 'ok', minLength: 2, maxLength: 2 },
            range: {
              type: 'object',
              required: ['width'],
              additionalProperties: false,
              properties: {
                width: {
                  type: 'integer',
                  enum: [2, 20],
                  const: 2,
                  minimum: 1,
                  maximum: 5,
                },
              },
            },
          },
        },
        code: {
          type: 'string',
          enum: ['a', 'abc', 'long'],
          const: 'abc',
          minLength: 3,
          maxLength: 3,
          default: 'abc',
        },
      },
    };
    const asset_id = 'repair/nested';
    await member.json(
      'POST',
      '/api/v1/lab/asset-versions',
      description(asset_id, '1.0', schema),
      201,
    );
    const good = {
      limits: [1, 2],
      payload: { range: { width: 2 }, mode: 'ok' },
      code: 'abc',
    };
    const registration = {
      name: 'Nested instance',
      definition_id: asset_id,
      definition_version: '1.0',
      reality: 'simulated',
      configuration: good,
    };
    const entity = await member.json<{
      id: string;
      configuration: unknown;
      definition_version: string;
    }>('POST', entities, registration, 201);
    await member.json(
      'POST',
      '/api/v1/lab/asset-versions',
      description(asset_id, '2.0', schema),
      201,
    );
    const path = entities + '/' + entity.id;
    for (const bad of [
      { ...good, limits: [1, 20] },
      { ...good, limits: [1] },
      { ...good, limits: [1, 2, 2] },
      { ...good, payload: { range: { width: 2 } } },
      { ...good, payload: { mode: 'ok', range: {} } },
      { ...good, payload: { mode: 'ok', range: { width: 20 } } },
      { ...good, payload: { mode: 'ok', range: { width: 2 }, extra: true } },
      { ...good, code: 'a' },
      { ...good, code: 'long' },
      { limits: good.limits, payload: good.payload },
      { ...good, extra: true },
    ]) {
      await member.error(
        'POST',
        entities,
        { ...registration, configuration: bad },
        400,
        'lab.invalid_input',
      );
      await member.error(
        'PATCH',
        path,
        { name: 'Nested instance', configuration: bad },
        400,
        'lab.invalid_input',
      );
      await member.error(
        'PUT',
        path + '/definition',
        {
          definition_id: asset_id,
          definition_version: '2.0',
          configuration: bad,
        },
        400,
        'lab.invalid_input',
      );
    }
    const unchanged = await member.json<typeof entity>('GET', path);
    assert.equal(unchanged.definition_version, '1.0');
    assert.deepEqual(unchanged.configuration, good);
    const adopted = await member.json<typeof entity>(
      'PUT',
      path + '/definition',
      {
        definition_id: asset_id,
        definition_version: '2.0',
        configuration: good,
      },
    );
    assert.equal(adopted.definition_version, '2.0');
    assert.deepEqual(adopted.configuration, good);
    await member.error(
      'POST',
      '/api/v1/lab/asset-versions',
      description(asset_id, '3.0', { ...schema, not: { type: 'object' } }),
      400,
      'lab.invalid_asset_description',
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'schema-conjunction.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});
