import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { boundedJson } from '../../platform/http/json.ts';
import {
  duplicateStructField,
  invalidI64Field,
} from '../../platform/http/json-syntax.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import {
  DeviceProgramRun,
  DeviceTask,
  DeviceTaskResult,
} from '../world/dto.ts';
import type { DeviceService } from './use-cases.ts';
export const EntityAction = z
  .object({
    capability: z.string(),
    parameters: z.unknown().refine((value) => value !== undefined),
  })
  .strict()
  .openapi('EntityAction');
export const DeviceCommand = z
  .object({
    id: z.string(),
    entity_id: z.string(),
    run_id: z.string(),
    actor_id: z.string(),
    actor_source: z.string(),
    request_key: z.string(),
    capability: z.string(),
    parameters: z.unknown().refine((value) => value !== undefined),
    status: z.string(),
    result: z.unknown().nullable().optional(),
    task_id: z.string().nullable().optional(),
    created_at: z.string().openapi({ format: 'date-time' }),
    updated_at: z.string().openapi({ format: 'date-time' }),
  })
  .openapi('DeviceCommand');
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 422, 503].map((status) => [
    status,
    json(ApiErrorResponse),
  ]),
);
export function deviceRoutes(
  app: ReturnType<typeof createApp>,
  devices: DeviceService,
) {
  const path = '/api/v1/lab/labs/{lab_id}/entities/{entity_id}',
    params = z.object({ lab_id: z.string(), entity_id: z.string() });
  app.openapi(
    createRoute({
      method: 'post',
      path: path + '/program/start',
      operationId: 'startLabDeviceProgram',
      tags: ['Lab'],
      request: { params },
      responses: {
        201: json(DeviceProgramRun),
        200: json(DeviceProgramRun),
        ...errors,
      },
    }),
    async (c) => {
      const p = c.req.valid('param'),
        result = await devices.start(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
        );
      return c.json(result.value, result.created ? 201 : 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: path + '/program/stop',
      operationId: 'stopLabDeviceProgram',
      tags: ['Lab'],
      request: { params },
      responses: { 200: json(DeviceProgramRun), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await devices.stop(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
        ),
        200,
      );
    },
  );
  app.use('/api/v1/lab/labs/:lab_id/entities/:entity_id/actions', boundedJson);
  app.openapi(
    createRoute({
      method: 'post',
      path: path + '/actions',
      operationId: 'invokeLabEntityAction',
      tags: ['Lab'],
      request: {
        params,
        headers: z.object({
          'Idempotency-Key': z.string().optional().openapi({
            description:
              'Required for implemented actions: reuse the same key and parameters after an uncertain response. An expired original Command returns 410 without re-execution. Changed parameters still return 409.',
          }),
        }),
        body: {
          required: true,
          content: { 'application/json': { schema: EntityAction } },
        },
      },
      responses: {
        202: json(DeviceCommand),
        410: json(ApiErrorResponse),
        ...errors,
      },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['capability', 'parameters']))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      const p = c.req.valid('param');
      return c.json(
        await devices.accept(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
          c.req.valid('json'),
          c.req.valid('json').capability !== 'centrifuge.start' ||
            !(
              invalidI64Field(c.req.raw, 'rpm', ['parameters']) ||
              invalidI64Field(c.req.raw, 'duration_seconds', ['parameters'])
            ),
        ),
        202,
      );
    },
    (result) => {
      if (!result.success)
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return undefined;
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: path + '/commands/{command_id}',
      operationId: 'getLabDeviceCommand',
      tags: ['Lab'],
      request: { params: params.extend({ command_id: z.string() }) },
      responses: {
        200: json(DeviceCommand),
        400: json(ApiErrorResponse),
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        404: json(ApiErrorResponse),
        503: json(ApiErrorResponse),
      },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await devices.command(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
          p.command_id,
        ),
        200,
      );
    },
  );
  for (const [kind, key, schema, operationId] of [
    ['runs', 'run_id', DeviceProgramRun, 'getLabDeviceProgramRun'],
    ['tasks', 'task_id', DeviceTask, 'getLabDeviceTask'],
    ['results', 'result_id', DeviceTaskResult, 'getLabDeviceTaskResult'],
  ] as const) {
    app.openapi(
      createRoute({
        method: 'get',
        path: path + '/' + kind + '/{' + key + '}',
        operationId,
        tags: ['Lab'],
        request: { params: params.extend({ [key]: z.string() }) },
        responses: {
          200: json(schema),
          400: json(ApiErrorResponse),
          401: json(ApiErrorResponse),
          403: json(ApiErrorResponse),
          404: json(ApiErrorResponse),
          503: json(ApiErrorResponse),
        },
      }),
      async (c) => {
        const p = c.req.valid('param');
        return c.json(
          await devices.record(
            c.req.raw.headers,
            c.get('requestId'),
            p.lab_id,
            p.entity_id,
            p[key],
            kind,
          ),
          200,
        );
      },
    );
  }
}
