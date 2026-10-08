import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import {
  ApiErrorResponse,
  requestBudgetResponse,
} from '../../platform/http/errors.ts';
import { boundedJsonAt } from '../../platform/http/json.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import {
  duplicateStructField,
  invalidI64Field,
} from '../../platform/http/json-syntax.ts';
import type { ProgressService } from './use-cases.ts';
import { guideProgressLimits } from './domain.ts';
import {
  SaveLabGuideProgress,
  LabGuideProgress,
  LabGuideProgressRead,
} from './dto.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const errors = {
  400: json(ApiErrorResponse),
  401: json(ApiErrorResponse),
  403: json(ApiErrorResponse),
  404: json(ApiErrorResponse),
  408: json(ApiErrorResponse),
  413: json(ApiErrorResponse),
  429: requestBudgetResponse,
  503: json(ApiErrorResponse),
};
export function progressRoutes(
  app: ReturnType<typeof createApp>,
  progress: ProgressService,
) {
  const path = '/api/v1/lab/guides/{guide_id}/{guide_version}/progress';
  const params = z.object({ guide_id: z.string(), guide_version: z.string() });
  app.use(
    '/api/v1/lab/guides/:guide_id/:guide_version/progress',
    async (c, next) => {
      if (c.req.method === 'PUT')
        await boundedJsonAt(guideProgressLimits.requestBytes)(
          c,
          async () => {},
        );
      await next();
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path,
      operationId: 'getLabGuideProgress',
      tags: ['Lab'],
      request: { params },
      responses: { 200: json(LabGuideProgressRead), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await progress.get(
          c.req.raw.headers,
          c.get('requestId'),
          p.guide_id,
          p.guide_version,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'put',
      path,
      operationId: 'saveLabGuideProgress',
      tags: ['Lab'],
      request: {
        params,
        body: {
          required: true,
          content: { 'application/json': { schema: SaveLabGuideProgress } },
        },
      },
      responses: {
        200: json(LabGuideProgress),
        409: json(ApiErrorResponse),
        ...errors,
      },
    }),
    async (c) => {
      if (
        invalidI64Field(c.req.raw, 'expected_revision') ||
        duplicateStructField(c.req.raw, Object.keys(SaveLabGuideProgress.shape))
      )
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      const p = c.req.valid('param');
      return c.json(
        await progress.save(
          c.req.raw.headers,
          c.get('requestId'),
          p.guide_id,
          p.guide_version,
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
