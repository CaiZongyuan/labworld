import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { LabWorld, PersistentLab } from './dto.ts';
import type { WorldSubscriptions } from './subscriptions.ts';
const WorldCollection = z
  .enum(['entities', 'nodes', 'assets', 'relationships'])
  .openapi('WorldCollection');
const WorldChange = z
  .object({
    collection: WorldCollection,
    id: z.string(),
    patch: z.unknown().nullable().optional(),
  })
  .openapi('WorldChange');
const WorldEvent = z
  .union([
    z.object({ type: z.literal('snapshot'), world: LabWorld }),
    z.object({
      type: z.literal('update'),
      version: z.string(),
      base_version: z.string(),
      lab: PersistentLab.nullable().optional(),
      changes: z.array(WorldChange),
    }),
    z.object({ type: z.literal('heartbeat'), version: z.string() }),
    z.object({ type: z.literal('resync'), reason: z.string() }),
    z.object({ type: z.literal('access_ended') }),
    z.object({ type: z.literal('runtime_status'), available: z.boolean() }),
  ])
  .openapi('WorldEvent', {}, { unionPreferredType: 'oneOf' });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 413, 503].map((status) => [
    status,
    {
      description: '',
      content: { 'application/json': { schema: ApiErrorResponse } },
    },
  ]),
);
export function subscriptionRoutes(
  app: ReturnType<typeof createApp>,
  subscriptions: WorldSubscriptions,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/labs/{lab_id}/world/subscribe',
      operationId: 'streamLabWorld',
      tags: ['Lab'],
      request: { params: z.object({ lab_id: z.string() }) },
      responses: {
        200: {
          description:
            'SSE snapshot then versioned property updates. 1 MiB/event, 8 queued events; resync discards the queue and closes. Credentials are checked on each 250ms polling cycle and before queued frame delivery; source/check timeouts close the stream.',
          content: { 'text/event-stream': { schema: WorldEvent } },
        },
        ...errors,
      },
    }),
    async (c) =>
      subscriptions.subscribe(
        c.req.raw.headers,
        c.get('requestId'),
        c.req.valid('param').lab_id,
      ),
  );
}
