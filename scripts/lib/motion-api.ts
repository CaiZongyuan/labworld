import { retainedOpenApi, type Json } from './contract-openapi.ts';
const operations = {
  '/api/v1/lab/labs/{lab_id}/motion-fixture': {
    get: 'getLabMotionFixture',
    post: 'createLabMotionFixture',
  },
  '/api/v1/lab/labs/{lab_id}/motion-fixture/{session_id}/viewer-tickets': {
    post: 'createLabMotionViewerTicket',
  },
  '/api/v1/lab/labs/{lab_id}/motion-fixture/{session_id}/publisher-tickets': {
    post: 'createLabMotionPublisherTicket',
  },
};
const object = (value: Json | undefined): { [key: string]: Json } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** Isolate the approved fixture API; unrelated additions remain baseline drift. */
export function motionApiParts(document: Json) {
  const existing = structuredClone(document) as { [key: string]: Json };
  const addition = structuredClone(document) as { [key: string]: Json };
  const paths = object(existing.paths),
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
