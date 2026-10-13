import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { publishAsset } from '../support/lab-assets-http.ts';
import type {
  FileInfo,
  UploadCapability,
  DownloadCapability,
} from '../../packages/contracts/src/generated/types.gen.ts';
import type {
  MachineCredential,
  SceneInstallation,
  SimulationSession,
} from '../../packages/contracts/src/generated/types.gen.ts';

test('a Member publishes and reads a complete immutable asset version without changing the legacy GLB contract', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('asset-author@example.test');
    const model = await publishAsset(
      member,
      await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
      'Existing model',
    );
    const description = {
      schema_version: 1,
      asset_id: 'example/centrifuge-c',
      version: '1.0.0',
      name: 'Centrifuge C',
      category: 'instrument',
      manufacturer: 'Example manufacturer',
      model: 'C',
      source: 'Contract fixture',
      license: 'CC0',
      specifications: { speed: { unit: 'rpm', minimum: 0, maximum: 15000 } },
      configuration_schema: {
        type: 'object',
        properties: { initial_temperature: { type: 'number', unit: 'degC' } },
        additionalProperties: false,
      },
      state_schema: {
        type: 'object',
        properties: {
          speed: { type: 'number', unit: 'rpm' },
          temperature: { type: 'number', unit: 'degC' },
        },
      },
      capabilities: [
        {
          id: 'centrifuge.start',
          version: '1.0',
          parameters: {
            type: 'object',
            properties: {
              rpm: { type: 'integer', minimum: 0, maximum: 15000, unit: 'rpm' },
            },
          },
          result: {
            type: 'object',
            properties: { accepted: { type: 'boolean' } },
          },
          description: 'Describes an operation; does not enable execution.',
        },
      ],
      resources: [
        {
          key: 'body',
          file_id: model.representation.file_id,
          format: 'glb',
          sha256: model.representation.sha256,
          size: model.representation.size,
        },
      ],
      representations: [
        {
          key: 'web',
          purpose: 'visual',
          resource_keys: ['body'],
          components: [
            {
              key: 'body',
              resource_key: 'body',
              local_origin: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
            },
          ],
        },
      ],
    };
    const published = await member.json<{
      id: string;
      asset_id: string;
      version: string;
      definition: { state_schema: unknown };
      resources: { representation_id: string }[];
    }>('POST', '/api/v1/lab/asset-versions', description, 201);
    assert.equal(published.asset_id, 'example/centrifuge-c');
    assert.equal(published.version, '1.0.0');
    assert.deepEqual(published.definition.state_schema, {
      type: 'object',
      properties: {
        speed: { type: 'number', unit: 'rpm' },
        temperature: { type: 'number', unit: 'degC' },
      },
    });
    assert.equal(
      published.resources[0].representation_id,
      model.representation.id,
    );
    assert.deepEqual(
      await member.json('GET', `/api/v1/lab/asset-versions/${published.id}`),
      published,
    );
    assert.deepEqual(
      await member.json('GET', `/api/v1/lab/assets/${model.id}`),
      model,
    );
    await target.stop();
    target.env.FILE_MAX_BYTES = '64';
    await target.start();
    await member.login('asset-author@example.test');
    assert.deepEqual(
      await member.json('POST', '/api/v1/lab/asset-versions', description, 201),
      published,
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'asset-version.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

async function uploadResource(
  member: CoreHttp,
  bytes: Buffer,
  file_name: string,
  content_type: string,
) {
  const upload = await member.json<UploadCapability>(
    'POST',
    '/api/v1/lab/asset-resource-uploads',
    {
      file_name,
      content_type,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    201,
  );
  const put = await fetch(upload.upload!.url, {
    method: 'PUT',
    headers: upload.upload!.headers,
    body: new Uint8Array(bytes),
  });
  assert.equal(put.status, 204);
  await put.arrayBuffer();
  const file = await member.json<FileInfo>(
    'POST',
    `/api/v1/lab/asset-resource-uploads/${upload.upload_id}/complete`,
  );
  return { upload, file };
}

test('resource uploads publish all representations once and cancelling an upload preserves the published version', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('multi-asset-author@example.test');
    const cube = await readFile(
      new URL('../fixtures/lab/cube.glb', import.meta.url),
    );
    const web = await uploadResource(
      member,
      cube,
      'body.glb',
      'model/gltf-binary',
    );
    const physics = await uploadResource(
      member,
      Buffer.from('#usda 1.0\ndef Xform "Robot" {}\n'),
      'model.usda',
      'model/vnd.usd',
    );
    const manual = await uploadResource(
      member,
      Buffer.from('%PDF-1.4\nAsset manual\n'),
      'manual.pdf',
      'application/pdf',
    );
    const resources = [
      {
        key: 'body',
        format: 'glb',
        file_id: web.file.id,
        sha256: web.file.sha256,
        size: web.file.size,
      },
      {
        key: 'physics',
        format: 'usd',
        file_id: physics.file.id,
        sha256: physics.file.sha256,
        size: physics.file.size,
      },
      {
        key: 'manual',
        format: 'pdf',
        file_id: manual.file.id,
        sha256: manual.file.sha256,
        size: manual.file.size,
      },
    ];
    const description = {
      schema_version: 1,
      asset_id: 'example/multi-component',
      version: '1.0.0',
      name: 'Two-link robot',
      category: 'robot',
      source: 'Fixture',
      license: 'CC0',
      specifications: {},
      configuration_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      state_schema: { type: 'object', properties: {} },
      capabilities: [],
      resources,
      representations: [
        {
          key: 'web',
          purpose: 'visual',
          resource_keys: ['body'],
          components: [
            {
              key: 'base',
              resource_key: 'body',
              local_origin: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
            },
            {
              key: 'shoulder',
              resource_key: 'body',
              local_origin: { position: [0, 1, 0], quaternion: [0, 0, 0, 1] },
            },
          ],
        },
        {
          key: 'physics',
          purpose: 'simulation',
          resource_keys: ['physics'],
          components: [],
        },
        {
          key: 'manual',
          purpose: 'documentation',
          resource_keys: ['manual'],
          components: [],
        },
      ],
    };
    const version = await member.json<{
      id: string;
      resources: { representation_id: string | null }[];
      representations: { components: unknown[] }[];
    }>('POST', '/api/v1/lab/asset-versions', description, 201);
    assert.equal(version.representations[0].components.length, 2);
    assert.equal(version.resources.length, 3);
    assert(version.resources[0].representation_id);
    assert.deepEqual(
      await member.json('POST', '/api/v1/lab/asset-versions', description, 201),
      version,
    );
    const uploadedAgain = await uploadResource(
      member,
      cube,
      'same-content-again.glb',
      'model/gltf-binary',
    );
    assert.notEqual(uploadedAgain.file.id, web.file.id);
    assert.deepEqual(
      await member.json(
        'POST',
        '/api/v1/lab/asset-versions',
        {
          ...description,
          resources: resources.map((resource) =>
            resource.key === 'body'
              ? { ...resource, file_id: uploadedAgain.file.id }
              : resource,
          ),
        },
        201,
      ),
      version,
    );
    await member.json(
      'DELETE',
      `/api/v1/lab/asset-resource-uploads/${uploadedAgain.upload.upload_id}`,
      undefined,
      204,
    );
    await member.error(
      'POST',
      '/api/v1/lab/asset-versions',
      { ...description, name: 'Changed robot' },
      409,
      'lab.asset_version_conflict',
    );
    const download = await member.json<DownloadCapability>(
      'GET',
      `/api/v1/lab/asset-versions/${version.id}/resources/body/download`,
    );
    await member.json(
      'DELETE',
      `/api/v1/lab/asset-resource-uploads/${web.upload.upload_id}`,
      undefined,
      204,
    );
    const bytes = await fetch(download.url);
    assert.equal(bytes.status, 200);
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), cube);
    assert.deepEqual(
      await member.json('GET', `/api/v1/lab/asset-versions/${version.id}`),
      version,
    );
    const listed = await member.json<{ data: { id: string }[] }>(
      'GET',
      '/api/v1/lab/asset-versions?asset_id=example%2Fmulti-component&version=1.0.0',
    );
    assert.deepEqual(
      listed.data.map((entry) => entry.id),
      [version.id],
    );
    assert.deepEqual(
      (await member.json<{ data: unknown[] }>('GET', '/api/v1/lab/assets'))
        .data,
      [],
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'asset-version.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('two equipment instances adopt one exact asset version with independent validated configuration and unknown observations', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('equipment-author@example.test');
    const description = {
      schema_version: 1,
      asset_id: 'example/centrifuge-two',
      version: '1.0.0',
      name: 'Centrifuge type',
      category: 'instrument',
      source: 'Fixture',
      license: 'CC0',
      specifications: { speed: { unit: 'rpm', maximum: 15000 } },
      configuration_schema: {
        type: 'object',
        properties: {
          temperature: { type: 'number', unit: 'degC', default: 4 },
          rotor: {
            type: 'object',
            properties: { slots: { type: 'integer', minimum: 1 } },
            required: ['slots'],
            additionalProperties: false,
          },
        },
        required: ['temperature', 'rotor'],
        additionalProperties: false,
      },
      state_schema: {
        type: 'object',
        properties: {
          speed: { type: 'number', unit: 'rpm' },
          temperature: { type: 'number', unit: 'degC' },
        },
      },
      capabilities: [
        {
          id: 'centrifuge.start',
          version: '1.0',
          parameters: {
            type: 'object',
            properties: { rpm: { type: 'integer', maximum: 15000 } },
          },
          result: { type: 'boolean' },
        },
      ],
      resources: [],
      representations: [],
    };
    const version = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/asset-versions',
      description,
      201,
    );
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Two instruments' },
      201,
    );
    const path = `/api/v1/lab/labs/${lab.id}/entities`;
    const input = {
      name: 'A',
      definition_id: 'example/centrifuge-two',
      definition_version: '1.0.0',
      reality: 'simulated',
      configuration: { temperature: 4, rotor: { slots: 8 } },
    };
    const first = await member.json<{
      id: string;
      configuration: unknown;
      observation: unknown;
      binding: unknown;
      definition: { asset_version: { id: string } };
      capabilities: { executable: boolean }[];
    }>('POST', path, input, 201);
    const second = await member.json<typeof first>(
      'POST',
      path,
      {
        ...input,
        name: 'B',
        configuration: { temperature: 20, rotor: { slots: 12 } },
      },
      201,
    );
    assert.notEqual(first.id, second.id);
    assert.equal(first.definition.asset_version.id, version.id);
    assert.equal(second.definition.asset_version.id, version.id);
    assert.deepEqual(first.configuration, {
      temperature: 4,
      rotor: { slots: 8 },
    });
    assert.deepEqual(second.configuration, {
      temperature: 20,
      rotor: { slots: 12 },
    });
    assert.equal(first.observation, null);
    assert.equal(second.observation, null);
    assert.equal(first.binding, null);
    assert.equal(second.binding, null);
    assert(first.capabilities.every((capability) => !capability.executable));
    await member.error(
      'POST',
      path,
      { ...input, configuration: { temperature: '4', rotor: { slots: 8 } } },
      400,
      'lab.invalid_input',
    );
    await member.error(
      'POST',
      path,
      { ...input, configuration: { rotor: { slots: 8 } } },
      400,
      'lab.invalid_input',
    );
    await member.error(
      'PATCH',
      path + '/' + first.id,
      { name: 'A', configuration: { temperature: 4, rotor: { slots: 0 } } },
      400,
      'lab.invalid_input',
    );
    assert.deepEqual(
      (await member.json<typeof first>('GET', path + '/' + first.id))
        .configuration,
      { temperature: 4, rotor: { slots: 8 } },
    );
    const next = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/asset-versions',
      { ...description, version: '2.0.0', name: 'Next model' },
      201,
    );
    assert.notEqual(next.id, version.id);
    assert.equal(
      (await member.json<typeof first>('GET', path + '/' + first.id)).definition
        .asset_version.id,
      version.id,
    );
    await target.stop();
    await target.start();
    await member.login('equipment-author@example.test');
    assert.equal(
      (await member.json<typeof first>('GET', path + '/' + first.id)).definition
        .asset_version.id,
      version.id,
    );
    assert.deepEqual(
      (await member.json<typeof first>('GET', path + '/' + second.id))
        .configuration,
      { temperature: 20, rotor: { slots: 12 } },
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'asset-version.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('invalid resource content and unsupported schema leave no published asset, and only the failed upload is cancelled', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('invalid-asset-author@example.test');
    const broken = await uploadResource(
      member,
      Buffer.from('{ broken JSON'),
      'manual.json',
      'application/json',
    );
    const description = {
      schema_version: 1,
      asset_id: 'example/invalid',
      version: '1.0',
      name: 'Invalid resource',
      category: 'model',
      source: 'Fixture',
      license: 'CC0',
      specifications: {},
      configuration_schema: { type: 'object', properties: {} },
      state_schema: { type: 'object', properties: {} },
      capabilities: [],
      resources: [
        {
          key: 'manual',
          format: 'json',
          file_id: broken.file.id,
          sha256: broken.file.sha256,
          size: broken.file.size,
        },
      ],
      representations: [
        {
          key: 'documentation',
          purpose: 'documentation',
          resource_keys: ['manual'],
          components: [],
        },
      ],
    };
    await member.error(
      'POST',
      '/api/v1/lab/asset-versions',
      description,
      400,
      'lab.invalid_asset_description',
    );
    assert.deepEqual(
      (
        await member.json<{ data: unknown[] }>(
          'GET',
          '/api/v1/lab/asset-versions',
        )
      ).data,
      [],
    );
    await member.json(
      'DELETE',
      `/api/v1/lab/asset-resource-uploads/${broken.upload.upload_id}`,
      undefined,
      204,
    );
    await member.error(
      'POST',
      `/api/v1/lab/asset-resource-uploads/${broken.upload.upload_id}/complete`,
      undefined,
      404,
      'lab.asset_resource_upload_not_found',
    );
    await member.error(
      'POST',
      '/api/v1/lab/asset-versions',
      {
        ...description,
        resources: [],
        representations: [],
        state_schema: {
          type: 'object',
          properties: { code: { type: 'string', pattern: '^[a-z]+$' } },
        },
      },
      400,
      'lab.invalid_asset_description',
    );
    await member.error(
      'POST',
      '/api/v1/lab/asset-versions',
      {
        ...description,
        resources: [],
        representations: [],
        asset_id: 'centrifuge',
      },
      400,
      'lab.invalid_asset_description',
    );
    await member.error(
      'POST',
      '/api/v1/lab/asset-versions',
      {
        ...description,
        resources: [],
        representations: [],
        state_schema: {
          type: 'object',
          properties: { speed: { type: 'string', unit: 'rpm' } },
        },
      },
      400,
      'lab.invalid_asset_description',
    );
    assert.deepEqual(
      (
        await member.json<{ data: unknown[] }>(
          'GET',
          '/api/v1/lab/asset-versions',
        )
      ).data,
      [],
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'asset-version.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('a Recording retains the adopted asset definition and nonvisual resources through a newer publication', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  target.env.FILE_PUBLIC_ORIGIN = target.url;
  target.env.LAB_WORD_SYNTHETIC_SESSION = 'true';
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('recorded-asset-author@example.test');
    const manualBytes = Buffer.from('%PDF-1.4\nRetained version one manual\n');
    const manual = await uploadResource(
      member,
      manualBytes,
      'manual.pdf',
      'application/pdf',
    );
    const description = {
      schema_version: 1,
      asset_id: 'example/recorded',
      version: '1.0',
      name: 'Recorded instrument',
      category: 'instrument',
      source: 'Fixture',
      license: 'CC0',
      specifications: {},
      configuration_schema: { type: 'object', properties: {} },
      state_schema: {
        type: 'object',
        properties: { temperature: { type: 'number', unit: 'degC' } },
      },
      capabilities: [],
      resources: [
        {
          key: 'manual',
          format: 'pdf',
          file_id: manual.file.id,
          sha256: manual.file.sha256,
          size: manual.file.size,
        },
      ],
      representations: [
        {
          key: 'manual',
          purpose: 'documentation',
          resource_keys: ['manual'],
          components: [],
        },
      ],
    };
    const version = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/asset-versions',
      description,
      201,
    );
    const lab = await member.json<{ id: string }>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Recording asset custody' },
      201,
    );
    const equipment = await member.json<{ id: string }>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/entities`,
      {
        name: 'Instrument',
        definition_id: 'example/recorded',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: {},
      },
      201,
    );
    const model = await publishAsset(
      member,
      await readFile(new URL('../fixtures/lab/cube.glb', import.meta.url)),
    );
    const installation = await member.json<SceneInstallation>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/installations`,
      { representation_id: model.representation.id },
      201,
    );
    const credential = await member.json<MachineCredential>(
      'POST',
      '/api/v1/machines',
      { name: 'Recording custody source' },
      201,
    );
    const session = await member.json<SimulationSession>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/sessions`,
      { installation_id: installation.id, machine_id: credential.machine.id },
      201,
    );
    const source = new CoreHttp(target.url, {
      authorization: 'Bearer ' + credential.credential,
    });
    await source.json(
      'POST',
      `/api/v1/lab/labs/${lab.id}/sessions/${session.id}/publisher-admissions`,
      { machine_id: credential.machine.id },
      201,
    );
    const recordings = await member.json<{
      data: { id: string; session_id: string }[];
    }>('GET', `/api/v1/lab/labs/${lab.id}/recordings`);
    const recording = recordings.data.find(
      (entry) => entry.session_id === session.id,
    )!;
    const resource = await member.response(
      'GET',
      `/api/v1/lab/labs/${lab.id}/recordings/${recording.id}/resources/${manual.file.id}`,
    );
    assert.equal(resource.status, 200);
    assert.deepEqual(Buffer.from(await resource.arrayBuffer()), manualBytes);
    await member.json(
      'POST',
      '/api/v1/lab/asset-versions',
      { ...description, version: '2.0', name: 'New instrument' },
      201,
    );
    const manifest = await member.json<{
      snapshot: {
        world: {
          entities: {
            id: string;
            definition: { asset_version?: { id: string; version: string } };
          }[];
        };
      };
    }>('GET', `/api/v1/lab/labs/${lab.id}/recordings/${recording.id}/manifest`);
    const recorded = manifest.snapshot.world.entities.find(
      (entry) => entry.id === equipment.id,
    )!;
    assert.equal(recorded.definition.asset_version!.id, version.id);
    assert.equal(recorded.definition.asset_version!.version, '1.0');
  } finally {
    console.log(
      JSON.stringify({
        event: 'asset-version.owned-ledger',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('the documented import and two-instance scripts run against public HTTP without leaking a key or starting a program', async () => {
  const target = await new ServerProcess().create(),
    script = await new ServerProcess().create();
  target.env = { APP_ORIGIN: target.url, FILE_PUBLIC_ORIGIN: target.url };
  try {
    await target.start();
    const member = new CoreHttp(target.url);
    await member.register('asset-guide@example.test');
    const key = await member.json<{ secret: string }>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Asset guide Agent', scopes: ['lab:full'], expires_in_days: 1 },
      201,
    );
    script.env = { LAB_API_BASE: target.url, LAB_API_KEY: key.secret };
    script.entry = 'examples/lab/import-asset-version.mjs';
    script.args = ['examples/lab/centrifuge.asset.json'];
    await script.spawn();
    assert.equal(
      await until(
        async () => script.child!.exitCode,
        (code) => code !== null,
      ),
      0,
    );
    const version = JSON.parse(script.logs);
    assert.equal(version.asset_id, 'tutorial/centrifuge-c');
    assert(!script.logs.includes(key.secret));
    await script.stop();
    script.entry = 'examples/lab/register-asset-instances.mjs';
    script.args = [];
    await script.spawn();
    assert.equal(
      await until(
        async () => script.child!.exitCode,
        (code) => code !== null,
      ),
      0,
    );
    const world = JSON.parse(script.logs);
    assert.equal(world.instances.length, 2);
    assert.notEqual(world.instances[0].id, world.instances[1].id);
    assert.equal(world.instances[0].asset_version_id, version.id);
    assert.equal(world.instances[1].asset_version_id, version.id);
    assert.equal(world.instances[0].observation, null);
    assert.equal(world.instances[1].binding, null);
    assert(!script.logs.includes(key.secret));
  } finally {
    for (const owner of [script, target]) {
      console.log(
        JSON.stringify({
          event: 'asset-guide.owned-ledger',
          path: owner.evidence + '/owned-resources.json',
        }),
      );
      await owner.cleanup();
    }
  }
});
