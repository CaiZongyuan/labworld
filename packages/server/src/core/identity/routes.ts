import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import type { FoundationContext } from '../../platform/context.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { boundedJson } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import type { AuthPolicy } from './domain.ts';
import {
  currentSession,
  register,
  login,
  logout,
  logoutValue,
  trustedOrigin,
} from './use-cases.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
export const MemberRole = z
  .enum(['owner', 'admin', 'member'])
  .openapi('MemberRole');
export const CurrentUser = z
  .object({
    id: z.string(),
    email: z.string(),
    display_name: z.string().nullable().optional(),
    role: MemberRole,
  })
  .openapi('CurrentUser');
export const CurrentSession = z
  .object({ user: CurrentUser, csrf_token: z.string() })
  .openapi('CurrentSession');
const Registration = z
  .object({
    email: z.string(),
    password: z.string(),
    display_name: z.string().nullable().optional(),
  })
  .strict()
  .openapi('Registration');
const Login = z
  .object({ email: z.string(), password: z.string() })
  .strict()
  .openapi('Login');
export function identityRoutes(
  app: ReturnType<typeof createApp>,
  context: FoundationContext,
  policy: AuthPolicy,
) {
  app.use('/api/v1/auth/logout', async (c, next) => {
    if (c.req.method === 'POST') {
      trustedOrigin(policy, c.req.header('origin') ?? null);
      logoutValue(policy, c.req.raw.headers);
    }
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/auth/logout',
      operationId: 'logoutUser',
      tags: ['Identity'],
      request: {
        headers: z.object({
          'x-csrf-token': z.string().openapi({
            param: {
              in: 'header',
              name: 'x-csrf-token',
              description: 'CSRF token from the current session',
            },
          }),
        }),
      },
      responses: {
        204: { description: '' },
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
      c.header(
        'set-cookie',
        await logout(context, policy, c.req.raw.headers, c.get('requestId')),
      );
      return c.body(null, 204);
    },
  );
  app.use('/api/v1/auth/login', async (c, next) => {
    if (c.req.method === 'POST') {
      await boundedJson(c, async () => {});
    }
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/auth/login',
      operationId: 'loginUser',
      tags: ['Identity'],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: Login } },
        },
      },
      responses: {
        200: json(CurrentSession),
        400: json(ApiErrorResponse),
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        408: json(ApiErrorResponse),
        413: json(ApiErrorResponse),
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
      if (duplicateStructField(c.req.raw, Object.keys(Login.shape)))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      trustedOrigin(policy, c.req.header('origin') ?? null);
      const result = await login(
        context,
        policy,
        c.req.valid('json'),
        c.get('requestId'),
      );
      c.header('set-cookie', result.cookie);
      return c.json(result.session, 200);
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
  app.use('/api/v1/auth/register', async (c, next) => {
    if (c.req.method === 'POST') {
      await boundedJson(c, async () => {});
    }
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/auth/register',
      operationId: 'registerUser',
      tags: ['Identity'],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: Registration } },
        },
      },
      responses: {
        201: json(CurrentSession),
        400: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        408: json(ApiErrorResponse),
        409: json(ApiErrorResponse),
        413: json(ApiErrorResponse),
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
      if (duplicateStructField(c.req.raw, Object.keys(Registration.shape)))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      trustedOrigin(policy, c.req.header('origin') ?? null);
      const result = await register(
        context,
        policy,
        c.req.valid('json'),
        c.get('requestId'),
      );
      c.header('set-cookie', result.cookie);
      return c.json(result.session, 201);
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
      path: '/api/v1/auth/session',
      operationId: 'getCurrentSession',
      tags: ['Identity'],
      responses: {
        200: json(CurrentSession),
        401: json(ApiErrorResponse),
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
        await currentSession(
          context,
          policy,
          c.req.raw.headers,
          c.get('requestId'),
        ),
        200,
      ),
  );
}
