import { z } from '@hono/zod-openapi';
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}]/u.test(value));
const record = z
  .record(z.string(), z.unknown())
  .openapi({ ...{ propertyNames: { type: 'string' as const } } });
export const AssetResourceInput = z
  .object({
    key: text(120),
    file_id: z.string().uuid(),
    format: z.enum(['glb', 'usd', 'urdf', 'pdf', 'json']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('AssetResourceInput');
export const AssetComponent = z
  .object({
    key: text(120),
    resource_key: text(120),
    local_origin: z
      .object({
        position: z.array(z.number().finite()).length(3),
        quaternion: z.array(z.number().finite()).length(4),
      })
      .strict(),
  })
  .strict()
  .openapi('AssetComponent');
export const VersionRepresentation = z
  .object({
    key: text(120),
    purpose: z.enum(['visual', 'simulation', 'documentation']),
    resource_keys: z.array(text(120)).min(1).max(128),
    components: z.array(AssetComponent).max(128),
  })
  .strict()
  .openapi('VersionRepresentation');
export const AssetCapabilityDescription = z
  .object({
    id: text(120),
    version: text(80),
    parameters: record,
    result: record,
    description: z.string().max(2048).optional(),
  })
  .strict()
  .openapi('AssetCapabilityDescription');
export const AssetBusinessDefinition = z
  .object({
    schema_version: z.literal(1),
    asset_id: text(256),
    version: text(80),
    name: text(120),
    name_en: text(120).optional(),
    category: text(80),
    manufacturer: text(200).optional(),
    model: text(200).optional(),
    description: z.string().max(4096).optional(),
    source: z.string().max(2048),
    license: z.string().max(200),
    specifications: record,
    configuration_schema: record,
    state_schema: record,
    capabilities: z.array(AssetCapabilityDescription).max(64),
  })
  .strict()
  .openapi('AssetBusinessDefinition');
export const ImportAssetVersion = AssetBusinessDefinition.extend({
  resources: z.array(AssetResourceInput).max(128),
  representations: z.array(VersionRepresentation).max(32),
})
  .strict()
  .openapi('ImportAssetVersion');
export const VersionResource = AssetResourceInput.extend({
  file_name: z.string(),
  content_type: z.string(),
  representation_id: z.string().uuid().nullable(),
  verification: z.enum([
    'glb-validated',
    'json-parsed',
    'pdf-header',
    'usd-header',
    'opaque',
  ]),
}).openapi('VersionResource');
export const CompleteAssetVersion = z
  .object({
    id: z.string().uuid(),
    asset_id: z.string(),
    namespace: z.string(),
    version: z.string(),
    content_sha256: z.string(),
    definition: AssetBusinessDefinition,
    resources: z.array(VersionResource),
    representations: z.array(VersionRepresentation),
    created_by: z.string().uuid(),
    created_at: z.string().openapi({ format: 'date-time' }),
  })
  .openapi('CompleteAssetVersion');
export const AssetVersionPage = z
  .object({
    data: z.array(CompleteAssetVersion),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  })
  .openapi('AssetVersionPage');
