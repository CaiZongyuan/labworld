import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import {
  ApiErrorResponse,
  requestBudgetResponse,
} from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { boundedJson } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import { LabEntity } from './dto.ts';
import type { WorldService } from './use-cases.ts';
import { entityLifecycle } from './lifecycle.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const ChangeEntityDefinition = z
  .object({
    definition_id: z.string(),
    definition_version: z.string(),
    configuration: z
      .record(z.string(), z.unknown())
      .openapi({ ...{ propertyNames: { type: 'string' as const } } }),
  })
  .strict()
  .openapi('ChangeEntityDefinition');
const ChangeEntityAppearance = z
  .object({
    representation_id: z.string().nullable().optional().openapi({
      description:
        'Null selects the built-in appearance. Applies to the Entity and all its current Scene Nodes.',
    }),
  })
  .strict()
  .openapi('ChangeEntityAppearance');
const errors = {
  ...Object.fromEntries(
    [400, 401, 403, 404, 503].map((status) => [status, json(ApiErrorResponse)]),
  ),
  429: requestBudgetResponse,
};
export function lifecycleRoutes(
  app: ReturnType<typeof createApp>,
  world: WorldService,
) {
  const path = '/api/v1/lab/labs/{lab_id}/entities/{entity_id}',
    params = z.object({ lab_id: z.string(), entity_id: z.string() });
  app.openapi(
    createRoute({
      method: 'post',
      path: path + '/archive',
      operationId: 'archiveLabEntity',
      tags: ['Lab'],
      request: { params },
      responses: {
        200: json(LabEntity),
        409: json(ApiErrorResponse),
        ...errors,
      },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await entityLifecycle(
          world,
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
          'archive',
        ),
        200,
      );
    },
  );
  for (const [kind, schema, operationId] of [
    ['definition', ChangeEntityDefinition, 'changeLabEntityDefinition'],
    ['appearance', ChangeEntityAppearance, 'changeLabEntityAppearance'],
  ] as const) {
    app.use(
      '/api/v1/lab/labs/:lab_id/entities/:entity_id/' + kind,
      boundedJson,
    );
    app.openapi(
      createRoute({
        method: 'put',
        path: path + '/' + kind,
        operationId,
        tags: ['Lab'],
        request: {
          params,
          body: { required: true, content: { 'application/json': { schema } } },
        },
        responses: {
          200: json(LabEntity),
          ...(kind === 'definition' ? { 409: json(ApiErrorResponse) } : {}),
          ...errors,
        },
      }),
      async (c) => {
        if (duplicateStructField(c.req.raw, Object.keys(schema.shape)))
          throw new PublicFailure(
            400,
            'http.invalid_json',
            'Provide a valid JSON request',
          );
        const p = c.req.valid('param');
        return c.json(
          await entityLifecycle(
            world,
            c.req.raw.headers,
            c.get('requestId'),
            p.lab_id,
            p.entity_id,
            kind,
            c.req.valid('json'),
          ),
          200,
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
  }
}
