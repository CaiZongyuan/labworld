import type { Json } from './contract-openapi.ts';
import { approvedApiParts } from './approved-api.ts';

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
/** Only the approved source operations leave the retained API comparison. */
export function sourceApiParts(document: Json) {
  return approvedApiParts(document, operations);
}
