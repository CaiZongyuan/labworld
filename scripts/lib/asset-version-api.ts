import { retainedOpenApi, type Json } from './contract-openapi.ts';
import { approvedApiParts } from './approved-api.ts';

const versions = '/api/v1/lab/asset-versions',
  uploads = '/api/v1/lab/asset-resource-uploads';
const operations = {
  [versions]: {
    get: 'listCompleteAssetVersions',
    post: 'importCompleteAssetVersion',
  },
  [`${versions}/{version_id}`]: { get: 'getCompleteAssetVersion' },
  [`${versions}/{version_id}/resources/{resource_key}/download`]: {
    get: 'downloadAssetVersionResource',
  },
  [uploads]: { post: 'startAssetResourceUpload' },
  [`${uploads}/{upload_id}/complete`]: {
    post: 'completeAssetResourceUpload',
  },
  [`${uploads}/{upload_id}`]: { delete: 'cancelAssetResourceUpload' },
};

/** Asset version imports extend the API without replacing old asset semantics. */
export function assetVersionApiParts(document: Json) {
  const parts = approvedApiParts(document, operations),
    existing = parts.existing as { [key: string]: Json },
    addition = parts.addition as { [key: string]: Json };
  const object = (value: Json | undefined): { [key: string]: Json } =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const definition = object(
      object(object(existing.components).schemas).AssetDefinition,
    ),
    properties = object(definition.properties);
  // Only this optional extension is approved. Requiredness and all other
  // definition fields remain visible against the old immutable baseline.
  if (properties.asset_version) {
    addition['x-asset-definition-version'] = properties.asset_version;
    // A removed import route must still leave this field's referenced schemas
    // available for comparison; the first partition may have pruned them.
    addition.components = structuredClone(object(document).components ?? {});
    delete properties.asset_version;
  }
  return {
    existing: retainedOpenApi(existing),
    addition: retainedOpenApi(addition),
  };
}
