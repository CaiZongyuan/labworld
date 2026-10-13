import { retainedOpenApi, type Json } from './contract-openapi.ts';

const object = (value: Json | undefined): { [key: string]: Json } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Separate exact reviewed operations; unknown additions remain retained drift. */
export function approvedApiParts(
  document: Json,
  operations: Record<string, Record<string, string>>,
) {
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
