import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ApiErrorResponse, errorEnvelope } from '../../platform/http/errors.ts';
import type { FoundationContext } from '../../platform/context.ts';
import { ready, systemStatus } from './use-cases.ts';
import { PublicFailure } from '../../platform/http/failure.ts';

const HealthResponse = z
  .object({ status: z.string() })
  .openapi('HealthResponse');
const SystemStatus = z
  .object({
    database: z.string(),
    schema_version: z.number().openapi({ type: 'integer', format: 'int64' }),
    service: z.string(),
    status: z.string(),
    version: z.string(),
  })
  .openapi('SystemStatus');
const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
export function createApp(
  context: FoundationContext,
  version: string,
  log: (entry: Record<string, unknown>) => void = (entry) =>
    console.log(JSON.stringify(entry)),
) {
  const app = new OpenAPIHono<{ Variables: { requestId: string } }>();
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    c.header('cache-control', 'no-store');
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const started = performance.now();
    try {
      await next();
    } finally {
      log({
        event: 'http.request',
        request_id: requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: performance.now() - started,
      });
    }
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/health/live',
      operationId: 'getLiveness',
      tags: ['System'],
      responses: { 200: json(HealthResponse, 'Process is alive') },
    }),
    (c) => c.json({ status: 'ok' }, 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/health/ready',
      operationId: 'getReadiness',
      tags: ['System'],
      responses: {
        200: json(HealthResponse, 'Database migrations are available'),
        503: json(ApiErrorResponse, 'Database is not ready'),
      },
    }),
    async (c) =>
      (await ready(context, c.get('requestId')))
        ? c.json({ status: 'ok' }, 200)
        : c.json(
            errorEnvelope(
              'database.unavailable',
              'Database is not ready',
              c.get('requestId'),
            ),
            503,
          ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/system/status',
      operationId: 'getSystemStatus',
      tags: ['System'],
      responses: {
        200: json(SystemStatus, 'Status from the live PostgreSQL connection'),
        429: {
          ...json(
            ApiErrorResponse,
            'Request budget exceeded; retry after the specified seconds',
          ),
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
        },
        503: json(
          ApiErrorResponse,
          'Database or migration metadata is unavailable',
        ),
      },
    }),
    async (c) => {
      const result = await systemStatus(context, c.get('requestId'), version);
      return result
        ? c.json(result, 200)
        : c.json(
            errorEnvelope(
              'database.unavailable',
              'Database is not ready',
              c.get('requestId'),
            ),
            503,
          );
    },
  );
  app.notFound((c) => {
    const known = [
      '/health/live',
      '/health/ready',
      '/api/v1/system/status',
      '/api/openapi.json',
    ].includes(c.req.path);
    return c.json(
      errorEnvelope(
        known ? 'http.method_not_allowed' : 'http.not_found',
        known ? 'Method not allowed' : 'Resource not found',
        c.get('requestId'),
      ),
      known ? 405 : 404,
    );
  });
  app.onError((error, c) =>
    c.json(
      errorEnvelope(
        error instanceof PublicFailure ? error.code : 'internal.error',
        error instanceof PublicFailure
          ? error.message
          : 'Internal server error',
        c.get('requestId'),
        error instanceof PublicFailure ? error.details : {},
      ),
      error instanceof PublicFailure ? error.status : 500,
    ),
  );
  app.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Lab Word Server (M1 foundation)', version },
  });
  return app;
}
