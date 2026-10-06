import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../system/routes.ts';
import type { FoundationContext } from '../../platform/context.ts';
import type { AuthPolicy } from '../identity/domain.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { pageQuery } from '../../platform/http/query.ts';
import { listAudit } from './management.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const Metadata = z
  .object({ subject_user_id: z.string().nullable().optional() })
  .openapi('Metadata');
const AuditEvent = z
  .object({
    id: z.string(),
    actor_id: z.string().nullable().optional(),
    actor_type: z.string(),
    action: z.string(),
    resource_type: z.string(),
    resource_id: z.string(),
    request_id: z.string().nullable().optional(),
    trace_id: z.string().nullable().optional(),
    correlation_id: z.string(),
    job_id: z.string().nullable().optional(),
    metadata: Metadata,
    created_at: z.string().openapi({ format: 'date-time' }),
  })
  .openapi('AuditEvent');
const AuditPage = z
  .object({
    data: z.array(AuditEvent),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
  })
  .openapi('AuditPage');
export function auditRoutes(
  app: ReturnType<typeof createApp>,
  context: FoundationContext,
  policy: AuthPolicy,
) {
  const short = z.string().optional().openapi({ maxLength: 200 });
  const Query = z.object({
    resource_id: short,
    action: short,
    request_id: short,
    resource_type: short,
    actor_id: z.string().optional(),
    correlation_id: short,
    job_id: z.string().optional(),
    limit: z.string().optional().openapi({
      type: 'integer',
      format: 'int32',
      minimum: 1,
      maximum: 100,
      default: 50,
    }),
    cursor: z.string().optional().openapi({ maxLength: 512 }),
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/audit-events',
      operationId: 'listAuditEvents',
      tags: ['Audit'],
      request: { query: Query },
      responses: {
        200: json(AuditPage),
        400: json(ApiErrorResponse),
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        429: {
          ...json(ApiErrorResponse),
          description:
            'Request budget exceeded; retry after the specified seconds',
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
        },
        503: json(ApiErrorResponse),
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const params = new URL(c.req.url).searchParams;
      if (Object.keys(Query.shape).some((key) => params.getAll(key).length > 1))
        throw new PublicFailure(
          400,
          'http.invalid_query',
          'Query parameters are invalid',
        );
      return c.json(
        await listAudit(
          context,
          policy,
          c.req.raw.headers,
          c.get('requestId'),
          { ...query, ...pageQuery(c.req.raw) },
        ),
        200,
      );
    },
    (result) => {
      if (!result.success)
        throw new PublicFailure(
          400,
          'http.invalid_query',
          'Query parameters are invalid',
        );
      return undefined;
    },
  );
}
