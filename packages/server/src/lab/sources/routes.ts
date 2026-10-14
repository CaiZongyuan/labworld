import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { createApp } from '../../core/system/routes.ts';
import {
  ApiErrorResponse,
  requestBudgetResponse,
} from '../../platform/http/errors.ts';
import { boundedJsonAt } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { SourceService } from './service.ts';
import {
  LabSource,
  LabSourcePage,
  RegisterLabSource,
  LabSourceConfiguration,
  ConnectLabSource,
  LabSourceHeartbeat,
  LabSourceConnection,
  DisconnectLabSource,
} from './dto.ts';

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
  413: json(ApiErrorResponse),
  429: requestBudgetResponse,
  503: json(ApiErrorResponse),
};
const invalid = () => {
  throw new PublicFailure(
    400,
    'http.invalid_json',
    'Provide a valid JSON request',
  );
};
const validate = (result: { success: boolean }) => {
  if (!result.success) invalid();
  return undefined;
};
export function sourceRoutes(
  app: ReturnType<typeof createApp>,
  sources: SourceService,
  transportAllowed: (c: Context) => boolean = () => false,
) {
  const base = '/api/v1/lab/labs/{lab_id}/sources',
    params = z.object({ lab_id: z.string().uuid() }),
    scope = params.extend({ source_id: z.string().uuid() });
  for (const path of [
    '/api/v1/lab/labs/:lab_id/sources',
    '/api/v1/lab/labs/:lab_id/sources/*',
  ])
    app.use(path, async (c, next) => {
      c.header('cache-control', 'no-store');
      if (c.req.method === 'POST') {
        if (!transportAllowed(c))
          throw new PublicFailure(
            404,
            'lab.source_transport_required',
            'Source access requires secure transport or direct loopback',
          );
        await boundedJsonAt(4096)(c, async () => {});
      }
      await next();
    });
  app.openapi(
    createRoute({
      method: 'get',
      path: base,
      operationId: 'listLabSources',
      tags: ['Lab'],
      request: { params },
      responses: { 200: json(LabSourcePage), ...errors },
    }),
    async (c) =>
      c.json(
        await sources.list(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
        ),
        200,
      ),
    validate,
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{source_id}',
      operationId: 'getLabSource',
      tags: ['Lab'],
      request: { params: scope },
      responses: { 200: json(LabSource), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await sources.get(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.source_id,
        ),
        200,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base,
      operationId: 'registerLabSource',
      tags: ['Lab'],
      request: {
        params,
        body: {
          required: true,
          content: { 'application/json': { schema: RegisterLabSource } },
        },
      },
      responses: { 201: json(LabSource), ...errors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['name'])) invalid();
      return c.json(
        await sources.register(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
          c.req.valid('json').name,
        ),
        201,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base + '/{source_id}/configuration',
      operationId: 'createLabSourceConfiguration',
      tags: ['Lab'],
      request: {
        params: scope,
        body: {
          required: true,
          content: { 'application/json': { schema: z.object({}).strict() } },
        },
      },
      responses: { 201: json(LabSourceConfiguration), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await sources.configuration(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.source_id,
        ),
        201,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base + '/{source_id}/revoke',
      operationId: 'revokeLabSource',
      tags: ['Lab'],
      request: {
        params: scope,
        body: {
          required: true,
          content: { 'application/json': { schema: z.object({}).strict() } },
        },
      },
      responses: { 204: { description: 'Source access revoked.' }, ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await sources.revoke(
        c.req.raw.headers,
        c.get('requestId'),
        p.lab_id,
        p.source_id,
      );
      return c.body(null, 204);
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base + '/{source_id}/connections',
      operationId: 'connectLabSource',
      tags: ['Lab'],
      request: {
        params: scope,
        body: {
          required: true,
          content: { 'application/json': { schema: ConnectLabSource } },
        },
      },
      responses: { 201: json(LabSourceConnection), ...errors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, Object.keys(ConnectLabSource.shape)))
        invalid();
      const p = c.req.valid('param');
      return c.json(
        await sources.connect(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.source_id,
          c.req.valid('json'),
        ),
        201,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base + '/{source_id}/heartbeat',
      operationId: 'heartbeatLabSource',
      tags: ['Lab'],
      request: {
        params: scope,
        body: {
          required: true,
          content: { 'application/json': { schema: LabSourceHeartbeat } },
        },
      },
      responses: { 200: json(LabSource), ...errors },
    }),
    async (c) => {
      if (
        duplicateStructField(c.req.raw, Object.keys(LabSourceHeartbeat.shape))
      )
        invalid();
      const p = c.req.valid('param');
      return c.json(
        await sources.heartbeat(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.source_id,
          c.req.valid('json'),
        ),
        200,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base + '/{source_id}/disconnect',
      operationId: 'disconnectLabSource',
      tags: ['Lab'],
      request: {
        params: scope,
        body: {
          required: true,
          content: { 'application/json': { schema: DisconnectLabSource } },
        },
      },
      responses: {
        204: { description: 'Source connection released.' },
        ...errors,
      },
    }),
    async (c) => {
      if (
        duplicateStructField(c.req.raw, Object.keys(DisconnectLabSource.shape))
      )
        invalid();
      const p = c.req.valid('param');
      await sources.disconnect(
        c.req.raw.headers,
        c.get('requestId'),
        p.lab_id,
        p.source_id,
        c.req.valid('json'),
      );
      return c.body(null, 204);
    },
    validate,
  );
}
