import { instantNanoseconds } from '../time.ts';
import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import {
  ApiErrorResponse,
  requestBudgetResponse,
} from '../../platform/http/errors.ts';
import { RetentionPolicy } from '../history/routes.ts';
import type { RecordsService } from './use-cases.ts';
const instant = z.string().openapi({ format: 'date-time' }),
  nullable = (schema: z.ZodType) => schema.nullable().optional(),
  json = (schema: z.ZodType) => ({
    description: '',
    content: { 'application/json': { schema } },
  });
const LabRecordType = z
  .enum(['command', 'task', 'event', 'run'])
  .openapi('LabRecordType');
const LabRecord = z
  .object({
    id: z.string(),
    record_type: z.string(),
    entity_id: z.string(),
    entity_name: z.string(),
    reality: z.string(),
    archived_at: nullable(instant),
    run_id: z.string(),
    binding_id: z.string(),
    command_id: nullable(z.string()),
    task_id: nullable(z.string()),
    result_id: nullable(z.string()),
    recorded_at: instant,
    ended_at: nullable(instant),
    state: z.string(),
    summary: z.string(),
    source: z.string(),
    actor_id: nullable(z.string()),
    actor_source: z.string(),
    actor_role: z.string(),
    data: z.unknown().refine((value) => value !== undefined),
  })
  .openapi('LabRecord');
const LabRecordGap = z
  .object({ from: instant, to: instant, reason: z.string() })
  .openapi('LabRecordGap');
const LabRecordCoverage = z
  .object({
    record_type: z.string(),
    retention_seconds: z
      .number()
      .nullable()
      .optional()
      .openapi({ type: ['integer', 'null'], format: 'int32', minimum: 0 }),
    preserves_unfinished: z.boolean(),
    captured_since: nullable(instant),
    fully_captured_since: nullable(instant),
    cleaned_before: nullable(instant),
    available_since: nullable(instant),
    oldest_record_at: nullable(instant),
    newest_record_at: nullable(instant),
    gaps: z.array(LabRecordGap),
  })
  .openapi('LabRecordCoverage');
const LabRecordsPage = z
  .object({
    from: instant,
    to: instant,
    queried_at: instant,
    query_upper_bound: instant,
    entity_id: nullable(z.string()),
    record_type: z
      .union([LabRecordType, z.null()])
      .openapi({}, { unionPreferredType: 'oneOf' })
      .optional(),
    retention: RetentionPolicy,
    coverage: z.array(LabRecordCoverage),
    max_page_items: z
      .number()
      .openapi({ type: 'integer', format: 'int32', minimum: 0 }),
    max_range_seconds: z.number().openapi({ type: 'integer', format: 'int64' }),
    max_response_bytes: z.number().openapi({ type: 'integer', minimum: 0 }),
    items: z.array(LabRecord),
    next_cursor: nullable(z.string()),
  })
  .openapi('LabRecordsPage');
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
export function recordsRoutes(
  app: ReturnType<typeof createApp>,
  records: RecordsService,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/labs/{lab_id}/records',
      operationId: 'listLabRecords',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string() }),
        query: z
          .object({
            from: inputInstant,
            to: inputInstant,
            entity_id: z.string().optional(),
            record_type: LabRecordType.optional(),
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
      responses: { 200: json(LabRecordsPage), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('query');
      if (q.limit !== undefined && !/^\+?\d+$/.test(q.limit))
        throw new PublicFailure(
          400,
          'http.invalid_query',
          'Query parameters are invalid',
        );
      return c.json(
        await records.list(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
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
