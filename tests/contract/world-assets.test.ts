import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, expect, test } from 'vitest';
import type {
  AssetDefinition,
  AssetPage,
  CreateAssetUpload,
  DeviceCommand,
  DeviceProgramRun,
  DownloadCapability,
  LabAsset,
  LabEntity,
  LabLayout,
  LabWorld,
  LayoutNode,
  LayoutRelationship,
  Placement,
  RegisterEntity,
  SaveLabLayout,
  SceneNode,
  UploadCapability,
} from '../../packages/contracts/src/generated/types.gen';
import { HttpClient, member, until } from './http';
import { createLab, entityPath, readEntity, register, world } from './lab';

let client: HttpClient;
let agent: HttpClient;
let collaborator: HttpClient;
const ownedDevices: { lab: string; id: string }[] = [];
beforeAll(async () => {
  client = await member();
  expect(client.session?.user.role).toBe('member');
  agent = (await client.agent()).client;
  collaborator = new HttpClient();
  await collaborator.login(process.env.CONTRACT_OWNER_EMAIL!);
});
afterEach(async () => {
  for (const { lab, id } of ownedDevices.splice(0)) {
    let entity = await readEntity(client, lab, id);
    if (entity.program_run?.status === 'running') {
      await client.json<DeviceProgramRun>(
        'POST',
        `${entityPath(lab, id)}/program/stop`,
      );
      entity = await readEntity(client, lab, id);
    }
    if (entity.observation) {
      expect(Object.keys(entity.observation.properties).length).toBeGreaterThan(
        0,
      );
      await until(
        () => readEntity(client, lab, id),
        (value) =>
          Object.values(value.observation!.properties).every(
            (property) => property.freshness === 'stale',
          ),
      );
    }
  }
});

const fixture = (name = 'cube.glb') =>
  readFile(new URL(`../fixtures/lab/${name}`, import.meta.url));
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const assetPath = (asset: LabAsset) => `/api/v1/lab/assets/${asset.id}`;
const completePath = (upload: UploadCapability) =>
  `/api/v1/lab/asset-uploads/${upload.upload_id}/complete`;
const layoutPath = (lab: string) => `/api/v1/lab/labs/${lab}/layout`;
const assets = () =>
  client.json<AssetPage>('GET', '/api/v1/lab/assets?limit=100');
const placement = (
  position: [number, number, number] = [0, 0, 0],
): Placement => ({
  position,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});
function layoutNodes(snapshot: LabWorld): LayoutNode[] {
  return snapshot.nodes.map(
    ({ id, entity_id, representation_id, placement }) => ({
      id,
      entity_id,
      representation_id,
      placement,
    }),
  );
}
const save = (actor: HttpClient, lab: string, body: SaveLabLayout) =>
  actor.json<LabLayout>('PUT', layoutPath(lab), body);
function uploadInput(bytes: Buffer, name: string): CreateAssetUpload {
  return {
    name,
    source: 'Contract geometry fixture',
    license: 'CC0',
    version: '1.0',
    file: {
      file_name: 'contract.glb',
      content_type: 'model/gltf-binary',
      size: bytes.length,
      sha256: digest(bytes),
    },
  };
}
const beginUpload = (
  actor: HttpClient,
  input: CreateAssetUpload,
  key = randomUUID(),
) =>
  actor.json<UploadCapability>(
    'POST',
    '/api/v1/lab/asset-uploads',
    input,
    201,
    {
      'idempotency-key': key,
    },
  );
async function uploadBytes(upload: UploadCapability, bytes: Buffer) {
  expect(upload.state).toBe('pending_upload');
  expect(upload.upload).not.toBeNull();
  const capability = upload.upload!;
  expect(capability.method).toBe('PUT');
  expect(Date.parse(capability.expires_at)).toBeGreaterThan(Date.now());
  const response = await fetch(capability.url, {
    method: capability.method,
    headers: capability.headers,
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(10_000),
  });
  // The existing storage contract specifies success, rather than an S3-only status.
  expect(response.ok, 'signed upload succeeds').toBe(true);
  await response.arrayBuffer();
}
async function publish(bytes: Buffer, name: string, actor = client) {
  const upload = await beginUpload(actor, uploadInput(bytes, name));
  await uploadBytes(upload, bytes);
  return actor.json<LabAsset>('POST', completePath(upload));
}
const signDownload = (asset: LabAsset, actor = client) =>
  actor.json<DownloadCapability>('GET', `${assetPath(asset)}/download`);
async function readBytes(capability: DownloadCapability, bytes: Buffer) {
  expect(capability.method).toBe('GET');
  expect(Date.parse(capability.expires_at)).toBeGreaterThan(Date.now());
  const response = await fetch(capability.url, {
    headers: capability.headers,
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status, 'signed download returns bytes').toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
}
async function registerInput(
  actor: HttpClient,
  lab: string,
  input: RegisterEntity,
) {
  return actor.json<LabEntity>(
    'POST',
    `/api/v1/lab/labs/${lab}/entities`,
    input,
    201,
  );
}
const entityInput = (name: string, definition = 'bench'): RegisterEntity => ({
  name,
  definition_id: definition,
  definition_version: '1.0',
  reality: 'simulated',
  configuration: {},
  representation_id: null,
});

// Typed fixture structure, used only to construct independently invalid public inputs.
type Gltf = {
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { byteLength: number; byteOffset?: number }[];
  accessors: {
    count: number;
    type: string;
    componentType: number;
    bufferView?: number;
    sparse?: unknown;
  }[];
  meshes: {
    primitives: {
      attributes: Record<string, number>;
      indices: number;
      extensions?: Record<string, { bufferView: number }>;
    }[];
  }[];
  nodes: { children?: number[] }[];
  scenes: unknown[];
  images: { bufferView?: number; mimeType?: string; uri?: string }[];
  textures: {
    source?: number;
    extensions?: Record<string, { source: number }>;
  }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
};
function gltf(bytes: Buffer): Gltf {
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
}
function rewriteGlb(bytes: Buffer, edit: (root: Gltf) => void): Buffer {
  const jsonLength = bytes.readUInt32LE(12);
  const root = gltf(bytes);
  edit(root);
  const json = Buffer.from(JSON.stringify(root));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const tail = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  [
    0x46546c67,
    2,
    20 + padded.length + tail.length,
    padded.length,
    0x4e4f534a,
  ].forEach((value, index) => header.writeUInt32LE(value, index * 4));
  return Buffer.concat([header, padded, tail]);
}
function corruptPayload(bytes: Buffer, select: (root: Gltf) => number): Buffer {
  const view = gltf(bytes).bufferViews[select(gltf(bytes))];
  const offset = 28 + bytes.readUInt32LE(12) + (view.byteOffset ?? 0);
  const corrupted = Buffer.from(bytes);
  corrupted.fill(0, offset, offset + view.byteLength);
  return corrupted;
}

// #2; lab_assets.rs upload retries, Member/Agent management and compressed byte preservation.
test('ASSET-01 signed upload, immutable ready bytes and completion retries survive rejected writes', async () => {
  const bytes = await fixture();
  const before = await assets();
  expect(before.max_upload_bytes).toBe(20 * 1024 * 1024);
  expect(before.max_decoded_resource_bytes).toBeGreaterThan(bytes.length);
  const input = uploadInput(bytes, 'Contract immutable asset');
  await client.error(
    'POST',
    '/api/v1/lab/asset-uploads',
    {
      ...input,
      file: { ...input.file, size: 20 * 1024 * 1024 + 1 },
    },
    413,
    'files.too_large',
    { 'idempotency-key': randomUUID() },
  );
  expect(await assets()).toEqual(before);
  const key = randomUUID();
  const pending = await beginUpload(client, input, key);
  const retry = await beginUpload(client, input, key);
  expect(retry.upload_id).toBe(pending.upload_id);
  await client.error(
    'POST',
    '/api/v1/lab/asset-uploads',
    { ...input, name: 'Changed intent' },
    409,
    'idempotency.conflict',
    { 'idempotency-key': key },
  );
  await client.error(
    'POST',
    completePath(pending),
    undefined,
    409,
    'files.upload_missing',
  );
  expect(await assets()).toEqual(before);
  await uploadBytes(pending, bytes);
  const wrongBytes = Buffer.from(bytes);
  wrongBytes[wrongBytes.length - 1] ^= 0xff;
  const refused = await fetch(pending.upload!.url, {
    method: 'PUT',
    headers: pending.upload!.headers,
    body: new Uint8Array(wrongBytes),
    signal: AbortSignal.timeout(10_000),
  });
  expect(refused.ok, 'signed checksum refuses different bytes').toBe(false);
  await refused.arrayBuffer();
  await client.error(
    'POST',
    completePath(pending),
    undefined,
    403,
    'auth.csrf',
    {
      'x-csrf-token': '',
    },
  );
  expect(await assets()).toEqual(before);
  const [asset, duplicate] = await Promise.all([
    client.json<LabAsset>('POST', completePath(pending)),
    agent.json<LabAsset>('POST', completePath(pending)),
  ]);
  expect(duplicate).toEqual(asset);
  expect(asset).toMatchObject({
    name: 'Contract immutable asset',
    source: 'Contract geometry fixture',
    license: 'CC0',
    version: '1.0',
    created_by: client.session!.user.id,
    representation: {
      file_id: pending.upload_id,
      file_name: 'contract.glb',
      content_type: 'model/gltf-binary',
      size: bytes.length,
      sha256: digest(bytes),
    },
  });
  expect(
    new Set([asset.id, asset.representation.id, pending.upload_id]).size,
  ).toBe(3);
  expect(
    (await assets()).data.filter((entry) => entry.id === asset.id),
  ).toEqual([asset]);
  const ready = await beginUpload(client, input, key);
  expect(ready).toEqual({
    upload_id: pending.upload_id,
    state: 'ready',
    upload: null,
  });
  expect(await agent.json<LabAsset>('GET', assetPath(asset))).toEqual(asset);
  await new HttpClient().error(
    'GET',
    `${assetPath(asset)}/download`,
    undefined,
    401,
    'auth.unauthorized',
  );
  await readBytes(await signDownload(asset, agent), bytes);
  await client.error(
    'PATCH',
    assetPath(asset),
    { name: '' },
    400,
    'lab.invalid_input',
  );
  expect(await client.json<LabAsset>('GET', assetPath(asset))).toEqual(asset);
  const renamed = await agent.json<LabAsset>('PATCH', assetPath(asset), {
    name: 'Recovered asset name',
  });
  expect(renamed).toMatchObject({
    id: asset.id,
    name: 'Recovered asset name',
    updated_by: client.session!.user.id,
    representation: asset.representation,
  });
  await readBytes(await signDownload(renamed), bytes);
  for (const name of ['cube-draco.glb', 'cube-meshopt.glb', 'cube-basis.glb']) {
    const compressed = await fixture(name);
    const published = await publish(compressed, `Contract ${name}`, agent);
    expect(published.representation).toMatchObject({
      size: compressed.length,
      sha256: digest(compressed),
    });
    await readBytes(await signDownload(published), compressed);
  }
});

// #2; lab_assets.rs structural, compressed/image payload and expanded resource validation.
test('ASSET-02 invalid GLB, declared size and revoked publication preserve the library; valid upload recovers', async () => {
  const bytes = await fixture();
  const draco = await fixture('cube-draco.glb');
  const meshopt = await fixture('cube-meshopt.glb');
  const basis = await fixture('cube-basis.glb');
  const microscope = await readFile(
    new URL(
      '../../apps/web/public/lab-assets/models/industrial-microscope.glb',
      import.meta.url,
    ),
  );
  const before = await assets();
  const invalid: [string, Buffer][] = [
    ['bad magic', Buffer.from('not a GLB')],
    [
      'external buffer',
      rewriteGlb(bytes, (root) => {
        root.buffers[0].uri = 'https://example.test/mesh.bin';
      }),
    ],
    [
      'missing accessor',
      rewriteGlb(bytes, (root) => {
        root.meshes[0].primitives[0].attributes.POSITION = 123456;
      }),
    ],
    [
      'external image',
      rewriteGlb(microscope, (root) => {
        delete root.images[0].bufferView;
        root.images[0].uri = 'https://example.test/texture.png';
      }),
    ],
    [
      'empty geometry',
      rewriteGlb(bytes, (root) => {
        root.accessors[0].count = 0;
      }),
    ],
    [
      'node cycle',
      rewriteGlb(bytes, (root) => {
        root.nodes[0].children = [0];
      }),
    ],
    [
      'missing scene',
      rewriteGlb(bytes, (root) => {
        root.scenes = [];
      }),
    ],
    [
      'position dimensions',
      rewriteGlb(bytes, (root) => {
        root.accessors[0].type = 'VEC2';
      }),
    ],
    [
      'indices type',
      rewriteGlb(bytes, (root) => {
        const index = root.meshes[0].primitives[0].indices;
        root.accessors[index].componentType = 5126;
        root.accessors[index].count = 18;
      }),
    ],
    [
      'Draco payload',
      corruptPayload(
        draco,
        (root) =>
          root.meshes[0].primitives[0].extensions!.KHR_draco_mesh_compression
            .bufferView,
      ),
    ],
    [
      'Basis payload',
      corruptPayload(basis, (root) => root.images[0].bufferView!),
    ],
    [
      'PNG payload',
      corruptPayload(microscope, (root) => root.images[0].bufferView!),
    ],
    [
      'Basis without declared extension',
      rewriteGlb(basis, (root) => {
        root.textures[0].source = 0;
        delete root.textures[0].extensions;
        root.extensionsUsed = [];
        root.extensionsRequired = [];
      }),
    ],
    [
      'expanded sparse accessor',
      rewriteGlb(bytes, (root) => {
        delete root.accessors[0].bufferView;
        root.accessors[0].count =
          Math.floor(before.max_decoded_resource_bytes / 12) + 1;
        root.accessors[0].sparse = {
          count: 1,
          indices: { bufferView: 1, componentType: 5123 },
          values: { bufferView: 0 },
        };
      }),
    ],
    [
      'expanded Meshopt buffer',
      rewriteGlb(meshopt, (root) => {
        root.buffers[1].byteLength = before.max_decoded_resource_bytes + 1;
      }),
    ],
  ];
  const brokenMeshopt = Buffer.from(meshopt);
  brokenMeshopt.fill(0, 28 + brokenMeshopt.readUInt32LE(12));
  invalid.push(['Meshopt payload', brokenMeshopt]);
  const expandedBasis = Buffer.from(basis);
  const imageView = gltf(basis).bufferViews[gltf(basis).images[0].bufferView!];
  expandedBasis.writeUInt32LE(
    before.max_decoded_resource_bytes,
    28 + basis.readUInt32LE(12) + (imageView.byteOffset ?? 0) + 20,
  );
  invalid.push(['expanded Basis texture', expandedBasis]);
  for (const [name, corrupted] of invalid) {
    const pending = await beginUpload(
      client,
      uploadInput(corrupted, `Rejected ${name}`),
    );
    await uploadBytes(pending, corrupted);
    await client.error(
      'POST',
      completePath(pending),
      undefined,
      422,
      'files.upload_rejected',
    );
    expect(await assets(), name).toEqual(before);
  }
  const wrongSize = uploadInput(bytes, 'Rejected declared size');
  wrongSize.file.size += 1;
  const pendingSize = await beginUpload(client, wrongSize);
  await uploadBytes(pendingSize, bytes);
  await client.error(
    'POST',
    completePath(pendingSize),
    undefined,
    422,
    'files.upload_rejected',
  );
  expect(await assets()).toEqual(before);
  const { client: temporaryAgent, credential } = await client.agent();
  const pending = await beginUpload(
    temporaryAgent,
    uploadInput(bytes, 'Recovered revoked publisher'),
  );
  await uploadBytes(pending, bytes);
  await client.json(
    'DELETE',
    `/api/v1/api-keys/${credential.key.id}`,
    undefined,
    204,
  );
  await temporaryAgent.error(
    'POST',
    completePath(pending),
    undefined,
    401,
    'auth.unauthorized',
  );
  expect(await assets()).toEqual(before);
  const recovered = await client.json<LabAsset>('POST', completePath(pending));
  expect(recovered.representation.file_id).toBe(pending.upload_id);
  expect((await assets()).data).toHaveLength(before.data.length + 1);
  await readBytes(await signDownload(recovered), bytes);
});

// #2/#3/#10; both Entity and Scene Node references protect the same physical bytes.
test('ASSET-03 node removal and archive retain references until explicitly released; Worker removes bytes before signature expiry', async () => {
  const bytes = await fixture();
  const asset = await publish(bytes, 'Contract reference protection');
  const lab = await createLab(client, 'Contract asset references');
  const entity = await registerInput(client, lab.id, {
    ...entityInput('Represented object', 'model'),
    representation_id: asset.representation.id,
  });
  let snapshot = await world(client, lab.id);
  expect(snapshot.entities).toEqual([entity]);
  expect(snapshot.assets).toEqual([asset]);
  expect(snapshot.nodes).toHaveLength(1);
  expect(snapshot.nodes[0]).toMatchObject({
    entity_id: entity.id,
    representation_id: asset.representation.id,
  });
  await client.error(
    'DELETE',
    assetPath(asset),
    undefined,
    409,
    'lab.asset_in_use',
  );
  expect(await world(client, lab.id)).toEqual(snapshot);
  await readBytes(await signDownload(asset), bytes);
  await save(client, lab.id, {
    expected_version: snapshot.lab.layout_version,
    nodes: [],
  });
  snapshot = await world(client, lab.id);
  expect(snapshot.nodes).toEqual([]);
  expect(snapshot.entities).toEqual([entity]);
  await client.error(
    'DELETE',
    assetPath(asset),
    undefined,
    409,
    'lab.asset_in_use',
  );
  expect(await world(client, lab.id)).toEqual(snapshot);
  const archived = await client.json<LabEntity>(
    'POST',
    `${entityPath(lab.id, entity.id)}/archive`,
  );
  expect(archived.id).toBe(entity.id);
  expect(archived.archived_at).toEqual(expect.any(String));
  snapshot = await world(client, lab.id);
  await agent.error(
    'DELETE',
    assetPath(asset),
    undefined,
    409,
    'lab.asset_in_use',
  );
  expect(await world(client, lab.id)).toEqual(snapshot);
  await client.json<LabEntity>(
    'PUT',
    `${entityPath(lab.id, entity.id)}/appearance`,
    { representation_id: null },
  );
  const node = await client.json<SceneNode>(
    'POST',
    `/api/v1/lab/labs/${lab.id}/nodes`,
    {
      entity_id: entity.id,
      representation_id: asset.representation.id,
      placement: placement([3, 0, 0]),
    },
    201,
  );
  snapshot = await world(client, lab.id);
  expect(snapshot.entities[0].representation_id).toBeNull();
  expect(snapshot.nodes).toEqual([node]);
  await client.error(
    'DELETE',
    assetPath(asset),
    undefined,
    409,
    'lab.asset_in_use',
  );
  expect(await world(client, lab.id)).toEqual(snapshot);
  const download = await signDownload(asset);
  await readBytes(download, bytes);
  await agent.json<LabEntity>(
    'PUT',
    `${entityPath(lab.id, entity.id)}/appearance`,
    { representation_id: null },
  );
  await client.json('DELETE', assetPath(asset), undefined, 204);
  await client.error(
    'GET',
    assetPath(asset),
    undefined,
    404,
    'lab.asset_not_found',
  );
  await client.error(
    'GET',
    `${assetPath(asset)}/download`,
    undefined,
    404,
    'lab.asset_not_found',
  );
  const removed = await world(client, lab.id);
  expect(removed.entities[0]).toMatchObject({
    id: entity.id,
    archived_at: archived.archived_at,
    representation_id: null,
  });
  expect(removed.nodes[0]).toMatchObject({
    id: node.id,
    entity_id: entity.id,
    representation_id: null,
  });
  expect(removed.assets).toEqual([]);
  const expiry = Date.parse(download.expires_at);
  const result = await until(
    async () => {
      const response = await fetch(download.url, {
        headers: download.headers,
        signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer();
      return { status: response.status, at: Date.now() };
    },
    (value) => value.status === 404,
    Math.min(15_000, expiry - Date.now() - 1_000),
  );
  expect(result.status).toBe(404);
  expect(
    result.at,
    'physical byte cleanup occurred while the original signature was valid',
  ).toBeLessThan(expiry);
});

// #2/Core files; lifetime comes from the public capability, with a fresh signing recovery.
test('ASSET-04 expired upload and download capabilities refuse bytes; fresh authenticated capabilities recover', async () => {
  const bytes = await fixture();
  const asset = await publish(bytes, 'Contract signature expiry');
  const before = await assets();
  const expiredUpload = await beginUpload(
    client,
    uploadInput(bytes, 'Contract expired upload'),
  );
  const uploadExpiry = Date.parse(expiredUpload.upload!.expires_at);
  const download = await signDownload(asset);
  await readBytes(download, bytes);
  const expiry = Date.parse(download.expires_at);
  const rejected = await until(
    async () => {
      const response = await fetch(download.url, {
        headers: download.headers,
        signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer();
      return { ok: response.ok, at: Date.now() };
    },
    (value) => !value.ok && value.at >= uploadExpiry,
    Math.max(expiry, uploadExpiry) - Date.now() + 5_000,
  );
  expect(rejected.at).toBeGreaterThanOrEqual(expiry);
  const refusedUpload = await fetch(expiredUpload.upload!.url, {
    method: expiredUpload.upload!.method,
    headers: expiredUpload.upload!.headers,
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(5_000),
  });
  expect(refusedUpload.ok, 'expired signed upload refuses bytes').toBe(false);
  await refusedUpload.arrayBuffer();
  // A storage signature can expire before the upload resource's own deadline.
  await until(
    async () => {
      const response = await client.response(
        'POST',
        completePath(expiredUpload),
      );
      const value = await response.json();
      if (response.status === 409) {
        expect(value.error.code).toBe('files.upload_missing');
      } else {
        expect(response.status).toBe(410);
        expect(value.error.code).toBe('files.upload_expired');
      }
      expect(value.error.request_id).toEqual(expect.any(String));
      return response.status;
    },
    (status) => status === 410,
    5_000,
  );
  expect(await assets()).toEqual(before);
  await readBytes(await signDownload(asset, agent), bytes);
  const fresh = await publish(bytes, 'Contract recovered upload', agent);
  expect(fresh.representation.file_id).not.toBe(expiredUpload.upload_id);
  await readBytes(await signDownload(fresh), bytes);
}, 75_000);

// #3; lab_world.rs identity/configuration/reference boundaries and Member/Agent reopen.
test('WORLD-01 Lab, Entity and Scene Node retain independent identities across rejected references and recovery', async () => {
  const lab = await createLab(client, 'Contract independent world');
  const empty = await world(client, lab.id);
  expect(empty.lab).toEqual(lab);
  expect(empty.entities).toEqual([]);
  expect(empty.nodes).toEqual([]);
  expect(empty.assets).toEqual([]);
  expect(empty.relationships).toEqual([]);
  const input = entityInput('Bench');
  for (const rejected of [
    { ...input, definition_version: 'missing' },
    { ...input, representation_id: randomUUID() },
    { ...input, configuration: { label: 'x'.repeat(8193) } },
  ]) {
    await client.error(
      'POST',
      `/api/v1/lab/labs/${lab.id}/entities`,
      rejected,
      400,
    );
    expect(await world(client, lab.id)).toEqual(empty);
  }
  const first = await registerInput(client, lab.id, input);
  const second = await registerInput(agent, lab.id, {
    ...input,
    name: 'Bench B',
  });
  expect(first.id).not.toBe(second.id);
  for (const entity of [first, second]) {
    expect(entity).toMatchObject({
      lab_id: lab.id,
      kind: 'furniture',
      definition_id: 'bench',
      definition_version: '1.0',
      reality: 'simulated',
      configuration: {},
      binding: null,
      program_run: null,
      observation: null,
    });
  }
  const changed = await client.json<LabEntity>(
    'PATCH',
    entityPath(lab.id, first.id),
    { name: 'Bench A', configuration: { label: 'north' } },
  );
  expect(changed).toMatchObject({
    id: first.id,
    name: 'Bench A',
    configuration: { label: 'north' },
    definition: first.definition,
  });
  let snapshot = await world(client, lab.id);
  expect(snapshot.entities).toHaveLength(2);
  expect(snapshot.nodes).toHaveLength(2);
  expect(snapshot.version).toEqual(expect.any(String));
  for (const entity of snapshot.entities) {
    const node = snapshot.nodes.find((entry) => entry.entity_id === entity.id)!;
    expect(node.id).not.toBe(entity.id);
    expect(node.placement).toEqual(
      placement(entity.id === first.id ? [0, 0, 0] : [1.5, 0, 0]),
    );
  }
  expect(await world(agent, lab.id)).toEqual(snapshot);
  const other = await createLab(client, 'Contract isolated Lab reference');
  const otherBefore = await world(client, other.id);
  await client.error(
    'POST',
    `/api/v1/lab/labs/${other.id}/nodes`,
    { entity_id: first.id, representation_id: null, placement: placement() },
    400,
    'lab.invalid_reference',
  );
  expect(await world(client, other.id)).toEqual(otherBefore);
  const beforeMissingReference = await world(client, lab.id);
  await client.error(
    'POST',
    `/api/v1/lab/labs/${lab.id}/nodes`,
    {
      entity_id: first.id,
      representation_id: randomUUID(),
      placement: placement(),
    },
    400,
    'lab.invalid_reference',
  );
  snapshot = await world(client, lab.id);
  expect(snapshot).toEqual(beforeMissingReference);
  expect(snapshot.entities.find((entry) => entry.id === first.id)).toEqual(
    changed,
  );
  expect(snapshot.nodes).toHaveLength(2);
  const added = await agent.json<SceneNode>(
    'POST',
    `/api/v1/lab/labs/${lab.id}/nodes`,
    {
      entity_id: first.id,
      representation_id: null,
      placement: placement([3, 0, 0]),
    },
    201,
  );
  expect(added).toMatchObject({
    entity_id: first.id,
    lab_id: lab.id,
    placement: placement([3, 0, 0]),
  });
  const reopened = await world(client, lab.id);
  expect(reopened.entities).toEqual(snapshot.entities);
  expect(reopened.nodes).toHaveLength(3);
  expect(reopened.nodes.find((node) => node.id === added.id)).toEqual(added);
});

// #3/#5; copy a known configured object, keep its frozen definition and create new identity.
test('WORLD-02 copying creates a new identity and stale copy leaves both objects unchanged before fresh-version retry', async () => {
  const lab = await createLab(client, 'Contract copied identities');
  const source = await registerInput(client, lab.id, {
    ...entityInput('Beaker A', 'labware'),
    configuration: { label: 'rack A' },
  });
  const before = await world(client, lab.id);
  const path = `${entityPath(lab.id, source.id)}/copies`;
  const input = {
    expected_version: before.lab.layout_version,
    name: 'Beaker B',
    placement: placement([2, 0.9, 0]),
  };
  const copied = await agent.json<LabEntity>('POST', path, input, 201);
  expect(copied.id).not.toBe(source.id);
  expect(copied.name).toBe('Beaker B');
  for (const field of [
    'definition',
    'definition_id',
    'definition_version',
    'configuration',
    'representation_id',
    'reality',
  ] as const) {
    expect(copied[field], field).toEqual(source[field]);
  }
  expect(copied.observation).toBeNull();
  expect(copied.program_run).toBeNull();
  const copiedWorld = await world(client, lab.id);
  expect(copiedWorld.entities).toHaveLength(2);
  expect(copiedWorld.nodes).toHaveLength(2);
  expect(
    copiedWorld.nodes.find((node) => node.entity_id === copied.id)?.placement,
  ).toEqual(placement([2, 0.9, 0]));
  expect(copiedWorld.relationships).toEqual([]);
  await client.error('POST', path, input, 409, 'lab.layout_conflict');
  expect(await world(client, lab.id)).toEqual(copiedWorld);
  const recovered = await client.json<LabEntity>(
    'POST',
    path,
    {
      ...input,
      expected_version: copiedWorld.lab.layout_version,
      name: 'Beaker C',
    },
    201,
  );
  expect(new Set([source.id, copied.id, recovered.id]).size).toBe(3);
  expect((await world(client, lab.id)).entities).toHaveLength(3);
  expect(await readEntity(client, lab.id, source.id)).toEqual(source);
});

// #3/#4/ADR0007; definitions and filtered Robot declarations never invent a Binding or state.
test('WORLD-03 simulated and physical Robots share definitions while unimplemented actions preserve distinct unknown identities', async () => {
  const definition = await agent.json<AssetDefinition>(
    'GET',
    '/api/v1/lab/asset-definitions/robot/1.0',
  );
  expect(definition).toMatchObject({
    id: 'robot',
    version: '1.0',
    category: 'robot',
  });
  await client.error(
    'GET',
    '/api/v1/lab/asset-definitions/robot/2.0',
    undefined,
    404,
    'lab.asset_not_found',
  );
  expect(
    await client.json<AssetDefinition>(
      'GET',
      '/api/v1/lab/asset-definitions/robot/1.0',
    ),
  ).toEqual(definition);
  const lab = await createLab(
    agent,
    'Contract physical and simulated identities',
  );
  const simulated = await registerInput(
    agent,
    lab.id,
    entityInput('Simulated Robot', 'robot'),
  );
  const physical = await registerInput(client, lab.id, {
    ...entityInput('Physical Robot', 'robot'),
    reality: 'physical',
  });
  await register(client, lab.id, 'bench');
  expect(simulated.id).not.toBe(physical.id);
  expect(simulated.definition).toEqual(definition);
  expect(physical.definition).toEqual(definition);
  const query = `/api/v1/lab/labs/${lab.id}/world?kind=robot&capability=robot.pick&state=unknown`;
  const filtered = await client.json<LabWorld>('GET', query);
  expect(filtered.entities.map((entity) => entity.id).sort()).toEqual(
    [simulated.id, physical.id].sort(),
  );
  expect(filtered.nodes).toHaveLength(2);
  for (const entity of filtered.entities) {
    expect(entity.binding).toBeNull();
    expect(entity.observation).toBeNull();
    expect(entity.program_run).toBeNull();
    for (const id of ['robot.move', 'robot.pick', 'robot.place']) {
      expect(
        entity.capabilities.find((capability) => capability.id === id),
      ).toMatchObject({
        definition_supported: true,
        binding_implemented: false,
        executable: false,
        reason: 'binding_not_implemented',
      });
      await agent.error(
        'POST',
        `${entityPath(lab.id, entity.id)}/actions`,
        { capability: id, parameters: {} },
        422,
        'lab.capability_not_implemented',
        { 'idempotency-key': randomUUID() },
      );
      expect(await client.json<LabWorld>('GET', query)).toEqual(filtered);
    }
  }
  const all = await world(client, lab.id);
  const simulation: LayoutRelationship = {
    id: randomUUID(),
    source_id: simulated.id,
    target_id: physical.id,
    kind: 'simulates',
  };
  await save(agent, lab.id, {
    expected_version: all.lab.layout_version,
    nodes: layoutNodes(all),
    relationships: [simulation],
  });
  const related = await world(client, lab.id);
  expect(related.relationships).toHaveLength(1);
  expect(related.relationships[0]).toMatchObject({
    ...simulation,
    source: 'manual',
    registered_by: client.session!.user.id,
  });
  expect(related.entities).toEqual(all.entities);
  await client.error(
    'PUT',
    layoutPath(lab.id),
    {
      expected_version: related.lab.layout_version,
      nodes: layoutNodes(related),
      relationships: [
        { ...simulation, source_id: physical.id, target_id: simulated.id },
      ],
    },
    400,
    'lab.invalid_reference',
  );
  expect(await world(client, lab.id)).toEqual(related);
  await save(client, lab.id, {
    expected_version: related.lab.layout_version,
    nodes: layoutNodes(related),
    relationships: [],
  });
  expect((await world(client, lab.id)).relationships).toEqual([]);
});

// #5; real concurrent CAS, placement/registration independence, graph rollback and explicit retry.
test('WORLD-04 concurrent layout CAS, relationship cycles and invalid placements preserve the committed world and recover', async () => {
  const lab = await createLab(
    client,
    'Contract layout and registered location',
  );
  const bench = await register(client, lab.id, 'bench');
  const beaker = await register(client, lab.id, 'labware');
  const robot = await register(client, lab.id, 'robot');
  const original = await world(client, lab.id);
  const location: LayoutRelationship = {
    id: randomUUID(),
    source_id: beaker.id,
    target_id: bench.id,
    kind: 'located_in',
  };
  const saved = await save(client, lab.id, {
    expected_version: original.lab.layout_version,
    nodes: layoutNodes(original),
    relationships: [location],
  });
  expect(saved.relationships).toHaveLength(1);
  expect(saved.relationships[0]).toMatchObject({
    ...location,
    source: 'manual',
    registered_by: client.session!.user.id,
  });
  expect(Number.isNaN(Date.parse(saved.relationships[0].registered_at))).toBe(
    false,
  );
  const before = await world(client, lab.id);
  const drafts = [placement([3, 0, 2]), placement([7, 0, 5])].map((value) => ({
    expected_version: before.lab.layout_version,
    nodes: layoutNodes(before).map((node) =>
      node.entity_id === beaker.id ? { ...node, placement: value } : node,
    ),
  }));
  const responses = await Promise.all([
    client.response('PUT', layoutPath(lab.id), drafts[0]),
    collaborator.response('PUT', layoutPath(lab.id), drafts[1]),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const winner = responses[0].status === 200 ? 0 : 1;
  const accepted = (await responses[winner].json()) as LabLayout;
  const conflict = await responses[1 - winner].json();
  expect(conflict.error.code).toBe('lab.layout_conflict');
  expect(conflict.error.request_id).toEqual(expect.any(String));
  expect(accepted.layout_version).toBe(before.lab.layout_version + 1);
  const committed = await world(client, lab.id);
  expect(
    committed.nodes.find((node) => node.entity_id === beaker.id)?.placement,
  ).toEqual(
    drafts[winner].nodes.find((node) => node.entity_id === beaker.id)!
      .placement,
  );
  expect(committed.entities).toEqual(before.entities);
  expect(committed.relationships).toEqual(saved.relationships);
  const nodes = layoutNodes(committed);
  for (const rejected of [
    [...nodes, nodes[0]],
    nodes.map((node, index) =>
      index === 0
        ? { ...node, placement: { ...node.placement, scale: [0, 1, 1] } }
        : node,
    ),
    nodes.map((node, index) =>
      index === 0 ? { ...node, placement: placement([10001, 0, 0]) } : node,
    ),
    nodes.map((node, index) =>
      index === 0 ? { ...node, representation_id: randomUUID() } : node,
    ),
    nodes.map((node, index) =>
      index === 0 ? { ...node, entity_id: randomUUID() } : node,
    ),
  ]) {
    await client.error(
      'PUT',
      layoutPath(lab.id),
      {
        expected_version: committed.lab.layout_version,
        nodes: rejected,
        relationships: [],
      },
      400,
    );
    expect(await world(client, lab.id)).toEqual(committed);
  }
  for (const relationships of [
    [
      location,
      {
        id: randomUUID(),
        source_id: beaker.id,
        target_id: bench.id,
        kind: 'contains',
      },
    ],
    [
      {
        id: randomUUID(),
        source_id: beaker.id,
        target_id: beaker.id,
        kind: 'contains',
      },
    ],
    [{ ...location, target_id: randomUUID() }],
    [{ ...location, target_id: robot.id }],
    [{ ...location, registered_by: bench.created_by }],
  ]) {
    await client.error(
      'PUT',
      layoutPath(lab.id),
      { expected_version: committed.lab.layout_version, nodes, relationships },
      400,
    );
    expect(await world(client, lab.id)).toEqual(committed);
  }
  await client.error(
    'PUT',
    layoutPath(lab.id),
    drafts[1 - winner],
    409,
    'lab.layout_conflict',
  );
  expect(await world(client, lab.id)).toEqual(committed);
  const recovered = await save(collaborator, lab.id, {
    expected_version: committed.lab.layout_version,
    nodes: nodes.map((node) =>
      node.entity_id === beaker.id
        ? { ...node, placement: placement([2, 0.9, 3]) }
        : node,
    ),
  });
  expect(recovered.relationships).toEqual(saved.relationships);
  const moved = await world(client, lab.id);
  expect(
    moved.nodes.find((node) => node.entity_id === beaker.id)?.placement,
  ).toEqual(placement([2, 0.9, 3]));
  expect(moved.entities).toEqual(committed.entities);
  await save(client, lab.id, {
    expected_version: moved.lab.layout_version,
    nodes: [],
  });
  const empty = await world(client, lab.id);
  expect(empty.nodes).toEqual([]);
  expect(empty.entities).toEqual(moved.entities);
  expect(empty.relationships).toEqual(saved.relationships);
  const restored = await agent.json<SceneNode>(
    'POST',
    `/api/v1/lab/labs/${lab.id}/nodes`,
    {
      entity_id: beaker.id,
      representation_id: null,
      placement: placement([1, 0, 0]),
    },
    201,
  );
  expect(restored.id).not.toBe(
    nodes.find((node) => node.entity_id === beaker.id)!.id,
  );
  const reopened = await world(client, lab.id);
  expect(reopened.nodes).toEqual([restored]);
  expect(reopened.entities).toEqual(moved.entities);
  expect(reopened.relationships).toEqual(saved.relationships);
});

// #10; lab_assets.rs running appearance replacement and lab_lifecycle.rs archive constraints.
test('LIFECYCLE-01 appearance preserves running identity and history; archive requires stopped program and retains references', async () => {
  const bytes = await fixture();
  const asset = await publish(bytes, 'Contract running appearance');
  const lab = await createLab(client, 'Contract running appearance lifecycle');
  const entity = await register(client, lab.id, 'light');
  ownedDevices.push({ lab: lab.id, id: entity.id });
  const path = entityPath(lab.id, entity.id);
  const run = await client.json<DeviceProgramRun>(
    'POST',
    `${path}/program/start`,
    undefined,
    201,
  );
  const accepted = await client.json<DeviceCommand>(
    'POST',
    `${path}/actions`,
    { capability: 'light.set_power', parameters: { on: true } },
    202,
    { 'idempotency-key': randomUUID() },
  );
  const command = await until(
    () => client.json<DeviceCommand>('GET', `${path}/commands/${accepted.id}`),
    (entry) => entry.status === 'succeeded',
  );
  const before = await readEntity(client, lab.id, entity.id);
  expect(before.program_run?.id).toBe(run.id);
  expect(before.observation?.values).toMatchObject({ on: true });
  const oldWorld = await world(client, lab.id);
  const changed = await agent.json<LabEntity>('PUT', `${path}/appearance`, {
    representation_id: asset.representation.id,
  });
  for (const field of [
    'id',
    'definition',
    'configuration',
    'binding',
    'program_run',
    'observation',
    'task',
    'task_result',
    'capabilities',
  ] as const) {
    expect(changed[field], field).toEqual(before[field]);
  }
  const snapshot = await world(client, lab.id);
  expect(snapshot.lab.layout_version).toBe(oldWorld.lab.layout_version + 1);
  expect(snapshot.nodes[0]).toMatchObject({
    id: oldWorld.nodes[0].id,
    entity_id: entity.id,
    representation_id: asset.representation.id,
  });
  expect(snapshot.assets).toEqual([asset]);
  await client.error(
    'PUT',
    `${path}/appearance`,
    { representation_id: randomUUID() },
    400,
    'lab.invalid_reference',
  );
  expect(await world(client, lab.id)).toEqual(snapshot);
  await client.error(
    'PUT',
    layoutPath(lab.id),
    { expected_version: oldWorld.lab.layout_version, nodes: [] },
    409,
    'lab.layout_conflict',
  );
  expect(await world(client, lab.id)).toEqual(snapshot);
  await agent.error(
    'POST',
    `${path}/archive`,
    undefined,
    409,
    'lab.entity_in_use',
  );
  expect(await world(client, lab.id)).toEqual(snapshot);
  const stopped = await client.json<DeviceProgramRun>(
    'POST',
    `${path}/program/stop`,
  );
  expect(stopped).toMatchObject({ id: run.id, status: 'stopped' });
  const archived = await agent.json<LabEntity>('POST', `${path}/archive`);
  expect(archived).toMatchObject({
    id: entity.id,
    representation_id: asset.representation.id,
    program_run: stopped,
  });
  expect(archived.archived_at).toEqual(expect.any(String));
  const archiveWorld = await world(client, lab.id);
  expect(archiveWorld.nodes).toEqual(snapshot.nodes);
  expect(archiveWorld.relationships).toEqual(snapshot.relationships);
  for (const [method, suffix, body] of [
    ['POST', 'program/start', undefined],
    [
      'POST',
      'actions',
      { capability: 'light.set_power', parameters: { on: false } },
    ],
    [
      'PUT',
      'definition',
      { definition_id: 'sensor', definition_version: '1.0', configuration: {} },
    ],
  ] as const) {
    await client.error(
      method,
      `${path}/${suffix}`,
      body,
      409,
      'lab.entity_archived',
      { 'idempotency-key': randomUUID() },
    );
    expect(await world(client, lab.id)).toEqual(archiveWorld);
  }
  await client.error(
    'DELETE',
    assetPath(asset),
    undefined,
    409,
    'lab.asset_in_use',
  );
  expect(await world(client, lab.id)).toEqual(archiveWorld);
  expect(
    await client.json<DeviceCommand>('GET', `${path}/commands/${command.id}`),
  ).toEqual(command);
  expect(await agent.json<LabEntity>('POST', `${path}/archive`)).toEqual(
    archived,
  );
  const restoredAppearance = await client.json<LabEntity>(
    'PUT',
    `${path}/appearance`,
    { representation_id: null },
  );
  expect(restoredAppearance).toMatchObject({
    id: entity.id,
    archived_at: archived.archived_at,
    representation_id: null,
    program_run: stopped,
  });
  expect((await world(client, lab.id)).nodes[0]).toMatchObject({
    id: oldWorld.nodes[0].id,
    representation_id: null,
  });
  await client.json('DELETE', assetPath(asset), undefined, 204);
});

// #10; old Run definition/source remain readable when a stopped Entity changes definition.
test('LIFECYCLE-02 definition change rejects a running program then preserves old Run meaning after explicit stop and restart', async () => {
  const lab = await createLab(client, 'Contract stopped definition change');
  const entity = await register(client, lab.id, 'light', {
    on: false,
    brightness: 25,
  });
  ownedDevices.push({ lab: lab.id, id: entity.id });
  const path = entityPath(lab.id, entity.id);
  const run = await client.json<DeviceProgramRun>(
    'POST',
    `${path}/program/start`,
    undefined,
    201,
  );
  const before = await world(client, lab.id);
  const input = {
    definition_id: 'sensor',
    definition_version: '1.0',
    configuration: { baseline_temperature: 25 },
  };
  await agent.error(
    'PUT',
    `${path}/definition`,
    input,
    409,
    'lab.entity_in_use',
  );
  expect(await world(client, lab.id)).toEqual(before);
  const stopped = await client.json<DeviceProgramRun>(
    'POST',
    `${path}/program/stop`,
  );
  const stoppedWorld = await world(client, lab.id);
  await client.error(
    'PUT',
    `${path}/definition`,
    { ...input, definition_version: '99.0' },
    400,
    'lab.invalid_reference',
  );
  expect(await world(client, lab.id)).toEqual(stoppedWorld);
  await client.error(
    'PUT',
    `${path}/definition`,
    { ...input, schema: {} },
    400,
  );
  expect(await world(client, lab.id)).toEqual(stoppedWorld);
  const changed = await agent.json<LabEntity>(
    'PUT',
    `${path}/definition`,
    input,
  );
  expect(changed).toMatchObject({
    id: entity.id,
    name: entity.name,
    definition_id: 'sensor',
    definition_version: '1.0',
    configuration: { baseline_temperature: 25 },
    binding: { entity_id: entity.id, program_id: 'sensor.v1' },
  });
  expect(changed.binding!.id).not.toBe(entity.binding!.id);
  const oldRun = await client.json<DeviceProgramRun>(
    'GET',
    `${path}/runs/${run.id}`,
  );
  expect(oldRun).toEqual(stopped);
  expect(oldRun).toMatchObject({
    id: run.id,
    definition_id: 'light',
    definition_version: '1.0',
    program_id: 'light.v1',
    configuration: { on: false, brightness: 25 },
    status: 'stopped',
  });
  expect((await world(client, lab.id)).nodes).toEqual(before.nodes);
  const next = await client.json<DeviceProgramRun>(
    'POST',
    `${path}/program/start`,
    undefined,
    201,
  );
  try {
    expect(next).toMatchObject({
      entity_id: entity.id,
      definition_id: 'sensor',
      program_id: 'sensor.v1',
      status: 'running',
      configuration: { baseline_temperature: 25 },
    });
    expect(next.id).not.toBe(run.id);
    expect(next.binding_id).toBe(changed.binding!.id);
    expect(next.source).not.toBe(run.source);
    expect(
      await client.json<DeviceProgramRun>('GET', `${path}/runs/${run.id}`),
    ).toEqual(stopped);
  } finally {
    await client.json<DeviceProgramRun>('POST', `${path}/program/stop`);
  }
});
