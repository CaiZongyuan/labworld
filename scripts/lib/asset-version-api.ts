import type { Json } from './contract-openapi.ts';
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
  return approvedApiParts(document, operations);
}
