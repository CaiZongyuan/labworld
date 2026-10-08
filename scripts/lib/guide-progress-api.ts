import { retainedOpenApi, type Json } from './contract-openapi.ts';

const path = '/api/v1/lab/guides/{guide_id}/{guide_version}/progress';
const operations = {
  get: 'getLabGuideProgress',
  put: 'saveLabGuideProgress',
} as const;
const object = (value: Json | undefined): { [key: string]: Json } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Split only the approved operations; every other addition remains baseline drift. */
export function guideProgressApiParts(document: Json) {
  const existing = structuredClone(document) as { [key: string]: Json };
  const addition = structuredClone(document) as { [key: string]: Json };
  const paths = object(existing.paths);
  const item = object(paths[path]);
  const added: { [key: string]: Json } = {};
  for (const [method, operationId] of Object.entries(operations)) {
    if (item[method]) added[method] = item[method];
    if (object(item[method]).operationId === operationId) delete item[method];
  }
  if (!Object.keys(item).length) delete paths[path];
  existing.paths = paths;
  addition.paths = Object.keys(added).length ? { [path]: added } : {};
  return {
    existing: retainedOpenApi(existing),
    addition: retainedOpenApi(addition),
  };
}
