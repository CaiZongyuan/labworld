import { retainedOpenApi, type Json } from './contract-openapi.ts';

const base = '/api/v1/lab/labs/{lab_id}/sources';
const operations = {
  [base]: { get: 'listLabSources', post: 'registerLabSource' },
  [`${base}/{source_id}`]: { get: 'getLabSource' },
  [`${base}/{source_id}/configuration`]: {
    post: 'createLabSourceConfiguration',
  },
  [`${base}/{source_id}/revoke`]: { post: 'revokeLabSource' },
  [`${base}/{source_id}/connections`]: { post: 'connectLabSource' },
  [`${base}/{source_id}/heartbeat`]: { post: 'heartbeatLabSource' },
  [`${base}/{source_id}/disconnect`]: { post: 'disconnectLabSource' },
};
const object = (value: Json | undefined): { [key: string]: Json } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Only the approved source operations leave the retained API comparison. */
export function sourceApiParts(document: Json) {
  const existing = structuredClone(document) as { [key: string]: Json },
    addition = structuredClone(document) as { [key: string]: Json },
    paths = object(existing.paths),
    addedPaths: { [key: string]: Json } = {};
  for (const [path, methods] of Object.entries(operations)) {
    const item = object(paths[path]),
      added: { [key: string]: Json } = {};
    for (const [method, operationId] of Object.entries(methods)) {
      if (item[method]) added[method] = item[method];
      if (object(item[method]).operationId === operationId) delete item[method];
    }
    if (!Object.keys(item).length) delete paths[path];
    if (Object.keys(added).length) addedPaths[path] = added;
  }
  existing.paths = paths;
  addition.paths = addedPaths;
  return {
    existing: retainedOpenApi(existing),
    addition: retainedOpenApi(addition),
  };
}
