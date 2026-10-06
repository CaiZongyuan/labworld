import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../system/routes.ts';
import type { FoundationContext } from '../../platform/context.ts';
import type { AuthPolicy } from '../identity/domain.ts';
import { MemberRole } from '../identity/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { pageQuery } from '../../platform/http/query.ts';
import { listMembers, updateMember } from './use-cases.ts';
import { boundedJson } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const Member = z
  .object({
    user_id: z.string(),
    email: z.string(),
    display_name: z.string().nullable().optional(),
    role: MemberRole,
    active: z.boolean(),
    version: z.number().openapi({ type: 'integer', format: 'int64' }),
    can_edit: z.boolean(),
  })
  .openapi('Member');
const MemberPage = z
  .object({
    data: z.array(Member),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
    assignable_roles: z.array(MemberRole),
  })
  .openapi('MemberPage');
export function organizationRoutes(
  app: ReturnType<typeof createApp>,
  context: FoundationContext,
  policy: AuthPolicy,
) {
  const UpdateMember = z
    .object({
      role: MemberRole,
      active: z.boolean(),
      version: z
        .number()
        .int()
        .openapi({ type: 'integer', format: 'int64', minimum: 1 }),
    })
    .strict()
    .openapi('UpdateMember');
  app.use('/api/v1/organization/members/:user_id', async (c, next) => {
    if (c.req.method === 'PUT') await boundedJson(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/organization/members/{user_id}',
      operationId: 'updateMember',
      tags: ['Organization'],
      request: {
        params: z.object({ user_id: z.string() }),
        headers: z.object({
          'x-csrf-token': z
            .string()
            .optional()
            .openapi({
              param: { name: 'x-csrf-token', in: 'header', required: true },
            }),
        }),
        body: {
          required: true,
          content: { 'application/json': { schema: UpdateMember } },
        },
      },
      responses: {
        200: json(Member),
        400: json(ApiErrorResponse),
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        404: json(ApiErrorResponse),
        408: json(ApiErrorResponse),
        409: json(ApiErrorResponse),
        413: json(ApiErrorResponse),
        422: json(ApiErrorResponse),
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
      if (duplicateStructField(c.req.raw, Object.keys(UpdateMember.shape)))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await updateMember(
          context,
          policy,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').user_id,
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
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/organization/members',
      operationId: 'listMembers',
      tags: ['Organization'],
      request: {
        query: z.object({
          limit: z.string().optional().openapi({
            type: 'integer',
            format: 'int32',
            minimum: 1,
            maximum: 100,
            default: 50,
          }),
          cursor: z.string().optional().openapi({ maxLength: 512 }),
        }),
      },
      responses: {
        200: json(MemberPage),
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
    async (c) =>
      c.json(
        await listMembers(
          context,
          policy,
          c.req.raw.headers,
          c.get('requestId'),
          pageQuery(c.req.raw),
        ),
        200,
      ),
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
