import { retainedOpenApi, type Json } from './contract-openapi.ts';
const operations = {
  '/api/v1/machines': { post: 'provisionMachine' },
  '/api/v1/machines/{machine_id}/revoke': { post: 'revokeMachine' },
  '/api/v1/lab/labs/{lab_id}/installations': {
    get: 'listLabSceneInstallations',
    post: 'createLabSceneInstallation',
  },
  '/api/v1/lab/labs/{lab_id}/installations/{installation_id}/archive': {
    post: 'archiveLabSceneInstallation',
  },
  '/api/v1/lab/labs/{lab_id}/sessions': {
    get: 'listLabSimulationSessions',
    post: 'startLabSimulationSession',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/events': {
    get: 'streamLabSimulationSessions',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/{session_id}': {
    get: 'getLabSimulationSession',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/{session_id}/pause': {
    post: 'pauseLabSimulationSession',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/{session_id}/resume': {
    post: 'resumeLabSimulationSession',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/{session_id}/stop': {
    post: 'stopLabSimulationSession',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/{session_id}/reset': {
    post: 'resetLabSimulationSession',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/{session_id}/viewer-tickets': {
    post: 'createLabSessionViewerTicket',
  },
  '/api/v1/lab/labs/{lab_id}/sessions/{session_id}/publisher-admissions': {
    post: 'admitLabSessionPublisher',
  },
};
const object = (value: Json | undefined): { [key: string]: Json } =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** Only approved #71 operations are separated; other additions remain semantic drift. */
export function sessionApiParts(document: Json) {
  const existing = structuredClone(document) as { [key: string]: Json },
    addition = structuredClone(document) as { [key: string]: Json },
    paths = object(existing.paths),
    addedPaths: { [key: string]: Json } = {};
  for (const [path, methods] of Object.entries(operations)) {
    const item = object(paths[path]),
      added: { [key: string]: Json } = {};
    for (const [method, operation] of Object.entries(methods)) {
      if (item[method]) added[method] = item[method];
      if (object(item[method]).operationId === operation) delete item[method];
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
