import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { boundedJsonAt } from '../../platform/http/json.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import type { MachineService } from './use-cases.ts';
const Machine = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    created_at: z.string(),
    expires_at: z.string(),
    revoked_at: z.string().nullable(),
  })
  .openapi('MachineIdentity');
const Provision = z
  .object({ name: z.string().min(1).max(120) })
  .strict()
  .openapi('ProvisionMachine');
const Credential = z
  .object({ machine: Machine, credential: z.string() })
  .openapi('MachineCredential');
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
export function machineRoutes(
  app: ReturnType<typeof createApp>,
  machines: MachineService,
) {
  app.use('/api/v1/machines', async (c, next) => {
    if (c.req.method === 'POST') await boundedJsonAt(4096)(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/machines',
      operationId: 'provisionMachine',
      tags: ['Identity'],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: Provision } },
        },
      },
      responses: { 201: json(Credential), ...errors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['name']))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await machines.provision(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('json').name,
        ),
        201,
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
      method: 'post',
      path: '/api/v1/machines/{machine_id}/revoke',
      operationId: 'revokeMachine',
      tags: ['Identity'],
      request: { params: z.object({ machine_id: z.string().uuid() }) },
      responses: { 204: { description: '' }, ...errors },
    }),
    async (c) => {
      await machines.revoke(
        c.req.raw.headers,
        c.get('requestId'),
        c.req.valid('param').machine_id,
      );
      return c.body(null, 204);
    },
  );
}
