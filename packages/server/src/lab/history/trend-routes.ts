import { instantNanoseconds } from '../time.ts';
import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import {
  ApiErrorResponse,
  requestBudgetResponse,
} from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { HistoryService } from './use-cases.ts';
import { entityTrend } from './trend.ts';
const instant = z.string().openapi({ format: 'date-time' }),
  integer = z.number().openapi({ type: 'integer', minimum: 0 }),
  nullable = (schema: z.ZodType) => schema.nullable().optional(),
  json = (schema: z.ZodType) => ({
    description: '',
    content: { 'application/json': { schema } },
  });
const TrendSample = z
  .object({
    id: z.string(),
    value: z.number().openapi({ format: 'double' }),
    sequence: z.number().openapi({ type: 'integer', format: 'int64' }),
    observed_at: nullable(instant),
    received_at: instant,
    expires_at: instant,
  })
  .openapi('TrendSample');
const TrendSegment = z
  .object({
    binding_id: z.string(),
    run_id: z.string(),
    source: z.string(),
    quality: z.string(),
    unit: nullable(z.string()),
    source_time_known: z.boolean(),
    resolution_seconds: z.number().openapi({ format: 'double' }),
    samples: z.array(TrendSample),
  })
  .openapi('TrendSegment');
const TrendGap = z
  .object({ from: instant, to: instant, reasons: z.array(z.string()) })
  .openapi('TrendGap');
const EntityTrend = z
  .object({
    property: z.string(),
    from: instant,
    to: instant,
    max_points: z
      .number()
      .openapi({ type: 'integer', format: 'int32', minimum: 0 }),
    raw_sample_count: integer,
    returned_sample_count: integer,
    plot_item_count: integer,
    sampling_strategy: z.string(),
    segments: z.array(TrendSegment),
    gaps: z.array(TrendGap),
    first_report_at: nullable(instant),
    last_report_at: nullable(instant),
    retained_since: instant,
    captured_since: instant,
    available_since: instant,
    observation_retention_seconds: z
      .number()
      .openapi({ type: 'integer', format: 'int32', minimum: 0 }),
    max_response_bytes: integer,
    max_range_seconds: z.number().openapi({ type: 'integer', format: 'int64' }),
  })
  .openapi('EntityTrend');
const inputInstant = instant.refine((value) => {
  try {
    instantNanoseconds(value);
    return true;
  } catch {
    return false;
  }
});
const errors = {
  ...Object.fromEntries(
    [400, 401, 403, 404, 413, 503].map((status) => [
      status,
      json(ApiErrorResponse),
    ]),
  ),
  429: requestBudgetResponse,
};
export function trendRoutes(
  app: ReturnType<typeof createApp>,
  history: HistoryService,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/labs/{lab_id}/entities/{entity_id}/trend',
      operationId: 'getLabEntityTrend',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string(), entity_id: z.string() }),
        query: z
          .object({
            property: z.string(),
            from: inputInstant,
            to: inputInstant,
            max_points: z.string().optional().openapi({
              type: 'integer',
              format: 'int32',
              minimum: 1,
              maximum: 1000,
              default: 600,
            }),
          })
          .strict(),
      },
      responses: { 200: json(EntityTrend), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param'),
        q = c.req.valid('query');
      if (q.max_points !== undefined && !/^\+?\d+$/.test(q.max_points))
        throw new PublicFailure(
          400,
          'http.invalid_query',
          'Query parameters are invalid',
        );
      return c.json(
        await entityTrend(
          history,
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
          q,
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
