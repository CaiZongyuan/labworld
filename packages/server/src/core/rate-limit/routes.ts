import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../system/routes.ts';
import type { FoundationContext } from '../../platform/context.ts';
import type { AuthPolicy } from '../identity/domain.ts';
import { currentSession } from '../identity/use-cases.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { LocalLimiter } from './domain.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const u32 = z
  .number()
  .openapi({ type: 'integer', format: 'int32', minimum: 0 });
const u64 = z
  .number()
  .openapi({ type: 'integer', format: 'int64', minimum: 0 });
const usize = z.number().openapi({ type: 'integer', minimum: 0 });
const PolicyMetrics = z
  .object({
    policy: z.string(),
    limit: u32,
    fallback_limit: u32,
    redis_allowed: u64,
    redis_denied: u64,
    local_allowed: u64,
    local_denied: u64,
    fallbacks: u64,
  })
  .openapi('PolicyMetrics');
const RateLimitMetrics = z
  .object({
    enabled: z.boolean(),
    redis_configured: z.boolean(),
    window_secs: u32,
    local_entries: usize,
    local_capacity: usize,
    policies: z.array(PolicyMetrics),
  })
  .openapi('RateLimitMetrics');
export function rateRoutes(
  app: ReturnType<typeof createApp>,
  context: FoundationContext,
  policy: AuthPolicy,
  limiter: LocalLimiter,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/system/rate-limits',
      operationId: 'getRateLimitStatus',
      tags: ['System'],
      responses: {
        200: json(RateLimitMetrics),
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
      const actor = await currentSession(
        context,
        policy,
        c.req.raw.headers,
        c.get('requestId'),
      );
      if (actor.user.role === 'member')
        throw new PublicFailure(
          403,
          'system.forbidden',
          'Only an administrator can inspect runtime counters',
        );
      return c.json(limiter.metrics(), 200);
    },
  );
}
