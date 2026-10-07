import { instantNanoseconds } from '../time.ts';
import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import type { HistoryService } from './use-cases.ts';
const instant = z.string().openapi({ format: 'date-time' }),
  json = (schema: z.ZodType) => ({
    description: '',
    content: { 'application/json': { schema } },
  }),
  u64 = z.number().openapi({ type: 'integer', format: 'int64', minimum: 0 });
export const RetentionPolicy = z
  .object({
    observation_seconds: z
      .number()
      .openapi({ type: 'integer', format: 'int32', minimum: 0 }),
    record_seconds: z
      .number()
      .openapi({ type: 'integer', format: 'int32', minimum: 0 }),
  })
  .openapi('RetentionPolicy');
const HistoryRecordType = z
  .enum(['observation', 'command', 'task', 'event'])
  .openapi('HistoryRecordType');
const HistoryRecord = z
  .object({
    id: z.string(),
    entity_id: z.string(),
    run_id: z.string(),
    recorded_at: instant,
    observed_at: instant.nullable().optional(),
    received_at: instant,
    data: z.unknown().refine((value) => value !== undefined),
  })
  .openapi('HistoryRecord');
const HistoryPage = z
  .object({
    record_type: HistoryRecordType,
    from: instant,
    to: instant,
    available_since: instant,
    gap: z.boolean(),
    retention: RetentionPolicy,
    max_range_seconds: z.number().openapi({ type: 'integer', format: 'int64' }),
    max_response_bytes: u64,
    items: z.array(HistoryRecord),
    next_cursor: z.string().nullable().optional(),
  })
  .openapi('HistoryPage');
const HistoryCleanup = z
  .object({
    observations: u64,
    commands: u64,
    tasks: u64,
    events: u64,
    more: z.boolean(),
    observation_cutoff: instant,
    record_cutoff: instant,
  })
  .openapi('HistoryCleanup');
const inputInstant = instant.refine((value) => {
  try {
    instantNanoseconds(value);
    return true;
  } catch {
    return false;
  }
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 503].map((status) => [status, json(ApiErrorResponse)]),
);
export function historyRoutes(
  app: ReturnType<typeof createApp>,
  history: HistoryService,
) {
  const path = '/api/v1/lab/labs/{lab_id}',
    params = z.object({ lab_id: z.string() });
  app.openapi(
    createRoute({
      method: 'get',
      path: path + '/history/retention',
      operationId: 'getLabHistoryRetention',
      tags: ['Lab'],
      request: { params },
      responses: { 200: json(RetentionPolicy), ...errors },
    }),
    async (c) =>
      c.json(
        await history.retention(
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
      path: path + '/history/cleanup',
      operationId: 'cleanupLabHistory',
      tags: ['Lab'],
      request: { params },
      responses: { 200: json(HistoryCleanup), ...errors },
    }),
    async (c) =>
      c.json(
        await history.cleanup(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: path + '/entities/{entity_id}/history',
      operationId: 'listLabDeviceHistory',
      tags: ['Lab'],
      request: {
        params: params.extend({ entity_id: z.string() }),
        query: z
          .object({
            record_type: HistoryRecordType,
            from: inputInstant,
            to: inputInstant,
            limit: z.string().optional().openapi({
              type: 'integer',
              format: 'int32',
              minimum: 1,
              maximum: 100,
              default: 20,
            }),
            cursor: z.string().optional().openapi({ maxLength: 2048 }),
          })
          .strict(),
      },
      responses: { 200: json(HistoryPage), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param'),
        q = c.req.valid('query');
      if (q.limit !== undefined && !/^\+?\d+$/.test(q.limit))
        throw new PublicFailure(
          400,
          'http.invalid_query',
          'Query parameters are invalid',
        );
      return c.json(
        await history.list(
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
