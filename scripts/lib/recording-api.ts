import { retainedOpenApi, type Json } from './contract-openapi.ts';

const base = '/api/v1/lab/labs/{lab_id}/recordings';
const operations = {
  [base]: { get: 'listLabRecordings' },
  [`${base}/{recording_id}`]: {
    get: 'getLabRecording',
    delete: 'deleteLabRecording',
  },
  [`${base}/{recording_id}/manifest`]: { get: 'getLabRecordingManifest' },
  [`${base}/{recording_id}/segments`]: { get: 'listLabRecordingSegments' },
  [`${base}/{recording_id}/events`]: { get: 'listLabRecordingEvents' },
  [`${base}/{recording_id}/segments/{segment_id}`]: {
    get: 'getLabRecordingSegment',
  },
};
const object = (value: Json | undefined): { [key: string]: Json } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Separate only approved #72 operations and the optional publisher bootstrap. */
export function recordingApiParts(document: Json) {
  const existing = structuredClone(document) as { [key: string]: Json };
  const addition = structuredClone(document) as { [key: string]: Json };
  const paths = object(existing.paths);
  const addedPaths: { [key: string]: Json } = {};
  for (const [path, methods] of Object.entries(operations)) {
    const item = object(paths[path]);
    const added: { [key: string]: Json } = {};
    for (const [method, operationId] of Object.entries(methods)) {
      if (item[method]) added[method] = item[method];
      if (object(item[method]).operationId === operationId) delete item[method];
    }
    if (!Object.keys(item).length) delete paths[path];
    if (Object.keys(added).length) addedPaths[path] = added;
  }
  existing.paths = paths;
  addition.paths = addedPaths;

  // This reference retains the exact extension's schema dependencies without
  // treating the existing publisher-admission operation as a new operation.
  const schemas = object(object(addition.components).schemas);
  const admission = object(schemas.PublisherAdmission);
  const fields = object(
    object(
      Array.isArray(admission.allOf)
        ? admission.allOf.find((part) => object(part).type === 'object')
        : undefined,
    ).properties,
  );
  schemas.PublisherAdmission = {
    type: 'object',
    properties: fields.recording ? { recording: fields.recording } : {},
  };
  addition['x-recording-publisher-admission'] = {
    $ref: '#/components/schemas/PublisherAdmission',
  };
  return {
    existing: retainedOpenApi(existing),
    addition: retainedOpenApi(addition),
  };
}
