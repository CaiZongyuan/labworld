import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../system/routes.ts';
import type { FoundationContext } from '../../platform/context.ts';
import type { AuthPolicy } from '../identity/domain.ts';
import type { KeyScope as Scope } from './domain.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { boundedJson } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import { pageQuery } from '../../platform/http/query.ts';
import { createKey, listKeys, keyScopes, revokeKey } from './use-cases.ts';
import { requireAccess } from './authentication.ts';
import { CurrentUser } from '../identity/routes.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const rate = {
  ...json(ApiErrorResponse),
  description: 'Request budget exceeded; retry after the specified seconds',
  headers: { 'Retry-After': { schema: { type: 'integer' as const } } },
};
const date = z.string().openapi({ format: 'date-time' });
const KeyInfo = z
  .object({
    id: z.string(),
    user_id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    created_at: date,
    expires_at: date,
    revoked_at: date.nullable().optional(),
    last_used_at: date.nullable().optional(),
  })
  .openapi('KeyInfo');
const CreatedApiKey = z
  .object({ key: KeyInfo, secret: z.string() })
  .openapi('CreatedApiKey');
const ApiKeyPage = z
  .object({
    data: z.array(KeyInfo),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
  })
  .openapi('ApiKeyPage');
const KeyScope = z
  .object({ id: z.string(), label: z.string() })
  .openapi('KeyScope');
const KeyScopeList = z
  .object({ data: z.array(KeyScope) })
  .openapi('KeyScopeList');
const CreateApiKey = z
  .object({
    name: z.string().openapi({ minLength: 1, maxLength: 100 }),
    scopes: z.array(z.string()).openapi({ minItems: 1, maxItems: 16 }),
    expires_in_days: z
      .number()
      .int()
      .min(0)
      .max(4294967295)
      .openapi({ type: 'integer', format: 'int32', minimum: 1, maximum: 365 }),
  })
  .strict()
  .openapi('CreateApiKey');
export function apiKeyRoutes(
  app: ReturnType<typeof createApp>,
  context: FoundationContext,
  policy: AuthPolicy,
  supported: readonly Scope[],
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/profile',
      operationId: 'getProfile',
      tags: ['Identity'],
      request: {
        headers: z.object({
          authorization: z
            .string()
            .nullable()
            .optional()
            .openapi({
              param: {
                name: 'authorization',
                in: 'header',
                description:
                  'Bearer API key with profile:read, or use a browser Session',
              },
            }),
        }),
      },
      responses: {
        200: json(CurrentUser),
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        429: rate,
        503: json(ApiErrorResponse),
      },
    }),
    async (c) =>
      c.json(
        (
          await requireAccess(
            context,
            policy,
            c.req.raw.headers,
            c.get('requestId'),
            'profile:read',
          )
        ).user,
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/api-keys/{id}',
      operationId: 'revokeApiKey',
      tags: ['API Keys'],
      request: {
        params: z.object({ id: z.string() }),
        headers: z.object({
          'x-csrf-token': z
            .string()
            .optional()
            .openapi({
              param: { name: 'x-csrf-token', in: 'header', required: true },
            }),
        }),
      },
      responses: {
        204: { description: '' },
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        404: json(ApiErrorResponse),
        429: rate,
        503: json(ApiErrorResponse),
      },
    }),
    async (c) => {
      await revokeKey(
        context,
        policy,
        c.req.raw.headers,
        c.get('requestId'),
        c.req.valid('param').id,
      );
      return c.body(null, 204);
    },
  );
  app.use('/api/v1/api-keys', async (c, next) => {
    if (c.req.method === 'POST') await boundedJson(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/api-keys',
      operationId: 'createApiKey',
      tags: ['API Keys'],
      request: {
        headers: z.object({
          'x-csrf-token': z
            .string()
            .optional()
            .openapi({
              param: { in: 'header', name: 'x-csrf-token', required: true },
            }),
        }),
        body: {
          required: true,
          content: { 'application/json': { schema: CreateApiKey } },
        },
      },
      responses: {
        201: json(CreatedApiKey),
        400: json(ApiErrorResponse),
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        429: rate,
        503: json(ApiErrorResponse),
      },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, Object.keys(CreateApiKey.shape)))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await createKey(
          context,
          policy,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('json'),
          supported,
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
      method: 'get',
      path: '/api/v1/api-keys',
      operationId: 'listApiKeys',
      tags: ['API Keys'],
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
        200: json(ApiKeyPage),
        400: json(ApiErrorResponse),
        401: json(ApiErrorResponse),
        429: rate,
        503: json(ApiErrorResponse),
      },
    }),
    async (c) =>
      c.json(
        await listKeys(
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
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/api-keys/scopes',
      operationId: 'listApiKeyScopes',
      tags: ['API Keys'],
      responses: {
        200: json(KeyScopeList),
        401: json(ApiErrorResponse),
        429: rate,
        503: json(ApiErrorResponse),
      },
    }),
    async (c) =>
      c.json(
        await keyScopes(
          context,
          policy,
          c.req.raw.headers,
          c.get('requestId'),
          supported,
        ),
        200,
      ),
  );
}
