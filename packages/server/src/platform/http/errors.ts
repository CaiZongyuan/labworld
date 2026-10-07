import { z } from '@hono/zod-openapi';
export const ApiError = z
  .object({
    code: z.string(),
    details: z
      .record(z.string(), z.string())
      .openapi({ ...{ propertyNames: { type: 'string' as const } } }),
    message: z.string(),
    request_id: z.string(),
  })
  .openapi('ApiError');
export const ApiErrorResponse = z
  .object({ error: ApiError })
  .openapi('ApiErrorResponse');
export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details: Record<string, string> = {},
) {
  return { error: { code, details, message, request_id: requestId } };
}

export const requestBudgetResponse = {
  description: 'Request budget exceeded; retry after the specified seconds',
  headers: { 'Retry-After': { schema: { type: 'integer' as const } } },
  content: { 'application/json': { schema: ApiErrorResponse } },
};
