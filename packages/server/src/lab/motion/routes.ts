import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { boundedJsonAt } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import type { MotionFixtures } from './fixture.ts';
const Target = z.object({
  pose_key: z.string(),
  entity_id: z.string().uuid(),
  node_id: z.string().uuid(),
  visual_target: z.literal('node-root'),
});
const Fixture = z
  .object({
    session_id: z.string().uuid(),
    lab_id: z.string().uuid(),
    scene_hash: z.string(),
    mapping_revision: z.number().int(),
    pose_keys: z.array(z.string()).max(1024),
    joint_keys: z.array(z.string()).max(1024),
    targets: z.array(Target).max(1024),
  })
  .openapi('MotionFixture');
const Create = z
  .object({ representation_id: z.string().uuid() })
  .strict()
  .openapi('CreateMotionFixture');
const Request = z
  .object({ preferred_rate_hz: z.union([z.literal(15), z.literal(30)]) })
  .strict()
  .openapi('RequestMotionTicket');
const Ticket = z
  .object({
    ticket: z.string(),
    expires_in_seconds: z.number().int(),
    websocket_path: z.string(),
  })
  .openapi('MotionTicket');
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const errors = {
  400: json(ApiErrorResponse),
  401: json(ApiErrorResponse),
  403: json(ApiErrorResponse),
  404: json(ApiErrorResponse),
  409: json(ApiErrorResponse),
  429: json(ApiErrorResponse),
  503: json(ApiErrorResponse),
};
const invalid = () => {
  throw new PublicFailure(
    400,
    'http.invalid_json',
    'Provide a valid JSON request',
  );
};
export function motionRoutes(
  app: ReturnType<typeof createApp>,
  fixtures: MotionFixtures,
  peer: (context: Context) => string | undefined = () => undefined,
) {
  const prefix = '/api/v1/lab/labs/{lab_id}/motion-fixture';
  app.use('/api/v1/lab/labs/:lab_id/motion-fixture', async (c, next) => {
    fixtures.guard(peer(c), c.req.raw.headers);
    if (c.req.method === 'POST') await boundedJsonAt(4096)(c, async () => {});
    c.header('cache-control', 'no-store');
    await next();
  });
  app.use('/api/v1/lab/labs/:lab_id/motion-fixture/*', async (c, next) => {
    fixtures.guard(peer(c), c.req.raw.headers);
    if (c.req.method === 'POST') await boundedJsonAt(4096)(c, async () => {});
    c.header('cache-control', 'no-store');
    await next();
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: prefix,
      operationId: 'getLabMotionFixture',
      tags: ['Lab'],
      request: { params: z.object({ lab_id: z.string() }) },
      responses: { 200: json(Fixture), ...errors },
    }),
    async (c) =>
      c.json(
        await fixtures.get(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: prefix,
      operationId: 'createLabMotionFixture',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: Create } },
        },
      },
      responses: { 201: json(Fixture), ...errors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['representation_id'])) invalid();
      return c.json(
        await fixtures.create(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
          c.req.valid('json').representation_id,
        ),
        201,
      );
    },
    (result) => {
      if (!result.success) invalid();
      return undefined;
    },
  );
  for (const role of ['viewer', 'publisher'] as const) {
    app.openapi(
      createRoute({
        method: 'post',
        path: `${prefix}/{session_id}/${role}-tickets`,
        operationId:
          role === 'viewer'
            ? 'createLabMotionViewerTicket'
            : 'createLabMotionPublisherTicket',
        tags: ['Lab'],
        request: {
          params: z.object({ lab_id: z.string(), session_id: z.string() }),
          body: {
            required: true,
            content: { 'application/json': { schema: Request } },
          },
        },
        responses: { 201: json(Ticket), ...errors },
      }),
      async (c) => {
        if (duplicateStructField(c.req.raw, ['preferred_rate_hz'])) invalid();
        const params = c.req.valid('param');
        return c.json(
          await fixtures.issue(
            c.req.raw.headers,
            c.get('requestId'),
            params.lab_id,
            params.session_id,
            role,
            c.req.valid('json').preferred_rate_hz,
          ),
          201,
        );
      },
      (result) => {
        if (!result.success) invalid();
        return undefined;
      },
    );
  }
}
