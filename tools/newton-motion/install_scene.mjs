import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    lab: { type: 'string' },
    directory: { type: 'string' },
    output: { type: 'string' },
  },
});
if (
  !values.server ||
  !values.lab ||
  !values.directory ||
  !values.output ||
  !process.env.LAB_WORD_API_KEY
)
  throw new Error(
    'Provide --server, --lab, --directory, --output and LAB_WORD_API_KEY.',
  );
const origin = new URL(values.server);
if (
  (origin.protocol !== 'https:' &&
    !(
      origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    )) ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  origin.pathname !== '/'
)
  throw new Error('Use an HTTPS origin or loopback HTTP origin.');
const directory = resolve(values.directory),
  profile = JSON.parse(await readFile(join(directory, 'profile.json'), 'utf8'));
const supported = JSON.parse(
  await readFile(
    new URL('./scene/supported-profile.json', import.meta.url),
    'utf8',
  ),
);
if (!isDeepStrictEqual(profile, supported))
  throw new Error('Use the exact repository-owned Newton package profile.');
const ledger = {
  owner: 'newton-scene-install',
  lab_id: values.lab,
  profile_sha256: profile.hash,
  assets: [],
  installation_id: null,
};
const save = () =>
  writeFile(resolve(values.output), JSON.stringify(ledger, null, 2) + '\n', {
    mode: 0o600,
  });
async function request(path, body, key) {
  const response = await fetch(new URL(path, origin), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.LAB_WORD_API_KEY,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error('Scene API rejected request with HTTP ' + response.status);
  return response.json();
}
await save();
const representations = {};
for (const [index, visual] of profile.visuals.entries()) {
  const data = await readFile(join(directory, visual.file));
  if (
    'sha256:' + createHash('sha256').update(data).digest('hex') !==
      visual.sha256 ||
    data.length !== visual.bytes
  )
    throw new Error('Prepared representation changed: ' + visual.file);
  const capability = await request(
    '/api/v1/lab/asset-uploads',
    {
      name: visual.file,
      source: 'https://github.com/CaiZongyuan/labworld',
      license:
        'Apache-2.0 original SO-ARM100 maker; Lab World derived scene and collision package; locally authored labware',
      version: profile.profile_id,
      file: {
        file_name: visual.file,
        content_type: 'model/gltf-binary',
        size: data.length,
        sha256: visual.sha256.slice(7),
      },
    },
    randomUUID(),
  );
  const entry = {
    pose_key: profile.body_order[index],
    upload_id: capability.upload_id,
    asset_id: null,
    representation_id: null,
  };
  ledger.assets.push(entry);
  await save();
  if (!capability.upload)
    throw new Error(
      'Upload capability unavailable; retain the ledger for recovery.',
    );
  const upload = await fetch(capability.upload.url, {
    method: capability.upload.method,
    headers: capability.upload.headers,
    body: data,
  });
  if (!upload.ok)
    throw new Error('Scene content upload failed with HTTP ' + upload.status);
  const asset = await request(
    '/api/v1/lab/asset-uploads/' + capability.upload_id + '/complete',
    {},
  );
  entry.asset_id = asset.id;
  entry.representation_id = asset.representation.id;
  representations[entry.pose_key] = entry.representation_id;
  await save();
}
const installation = await request(
  '/api/v1/lab/labs/' + values.lab + '/installations',
  {
    backend: 'newton',
    representation_id: representations['so101/base'],
    representations,
  },
);
ledger.installation_id = installation.id;
await save();
console.log(
  JSON.stringify({
    installation_id: installation.id,
    scene_hash: installation.scene_hash,
    assets: ledger.assets.length,
  }),
);
