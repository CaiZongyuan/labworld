import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import type { FileService } from '../../core/files/use-cases.ts';
import {
  UploadInput,
  UploadCapability,
  DownloadCapability,
} from '../../core/files/dto.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { boundedJson } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import {
  startAssetUpload,
  completeAssetUpload,
  getAsset,
  downloadAsset,
  listAssets,
  renameAsset,
  deleteAsset,
} from './use-cases.ts';
const CreateAssetUpload = z
  .object({
    name: z.string(),
    source: z.string(),
    license: z.string(),
    version: z.string(),
    file: UploadInput,
  })
  .strict()
  .openapi('CreateAssetUpload');
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const instant = z.string().openapi({ format: 'date-time' });
const RenameAsset = z
  .object({ name: z.string() })
  .strict()
  .openapi('RenameAsset');
export const AssetRepresentation = z
  .object({
    id: z.string(),
    file_id: z.string(),
    file_name: z.string(),
    size: z.number().openapi({ type: 'integer', format: 'int64' }),
    sha256: z.string(),
    content_type: z.string(),
  })
  .openapi('AssetRepresentation');
export const LabAsset = z
  .object({
    id: z.string(),
    name: z.string(),
    source: z.string(),
    license: z.string(),
    version: z.string(),
    created_by: z.string(),
    updated_by: z.string(),
    created_at: instant,
    updated_at: instant,
    representation: AssetRepresentation,
  })
  .openapi('LabAsset');
const AssetPage = z
  .object({
    data: z.array(LabAsset),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean(),
    max_upload_bytes: z.number().openapi({ type: 'integer', format: 'int64' }),
    max_decoded_resource_bytes: z
      .number()
      .openapi({ type: 'integer', format: 'int64' }),
  })
  .openapi('AssetPage');
const csrf = z.object({
  'x-csrf-token': z
    .string()
    .optional()
    .openapi({ param: { name: 'x-csrf-token', in: 'header', required: true } }),
});
const errors = {
  400: json(ApiErrorResponse),
  401: json(ApiErrorResponse),
  403: json(ApiErrorResponse),
  404: json(ApiErrorResponse),
  409: json(ApiErrorResponse),
  410: json(ApiErrorResponse),
  413: json(ApiErrorResponse),
  422: json(ApiErrorResponse),
  429: {
    ...json(ApiErrorResponse),
    description: 'Request budget exceeded; retry after the specified seconds',
    headers: { 'Retry-After': { schema: { type: 'integer' as const } } },
  },
  503: json(ApiErrorResponse),
};
const readErrors = {
  401: errors[401],
  403: errors[403],
  404: errors[404],
  429: errors[429],
  503: errors[503],
};
export function assetRoutes(
  app: ReturnType<typeof createApp>,
  files: FileService,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/assets',
      operationId: 'listLabAssets',
      tags: ['Lab'],
      request: {
        query: z.object({
          limit: z.string().optional().openapi({
            type: 'integer',
            format: 'int32',
            minimum: 1,
            maximum: 100,
            default: 50,
          }),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: json(AssetPage),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        429: errors[429],
        503: errors[503],
      },
    }),
    async (c) => {
      const query = c.req.valid('query'),
        parameters = new URL(c.req.url).searchParams;
      if (
        parameters.getAll('limit').length > 1 ||
        parameters.getAll('cursor').length > 1 ||
        (query.limit !== undefined && !/^\d+$/.test(query.limit))
      )
        throw new PublicFailure(
          400,
          'http.invalid_query',
          'Query parameters are invalid',
        );
      return c.json(
        await listAssets(files, c.req.raw.headers, c.get('requestId'), {
          limit: query.limit === undefined ? undefined : Number(query.limit),
          cursor: query.cursor,
        }),
        200,
      );
    },
  );
  app.use('/api/v1/lab/assets/:id', async (c, next) => {
    if (c.req.method === 'PATCH') await boundedJson(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/lab/assets/{id}',
      operationId: 'renameLabAsset',
      tags: ['Lab'],
      request: {
        params: z.object({ id: z.string() }),
        headers: csrf,
        body: {
          required: true,
          content: { 'application/json': { schema: RenameAsset } },
        },
      },
      responses: { 200: json(LabAsset), 400: errors[400], ...readErrors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['name']))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await renameAsset(
          files,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').id,
          c.req.valid('json').name,
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
      method: 'delete',
      path: '/api/v1/lab/assets/{id}',
      operationId: 'deleteLabAsset',
      tags: ['Lab'],
      request: { params: z.object({ id: z.string() }), headers: csrf },
      responses: { 204: { description: '' }, 409: errors[409], ...readErrors },
    }),
    async (c) => {
      await deleteAsset(
        files,
        c.req.raw.headers,
        c.get('requestId'),
        c.req.valid('param').id,
      );
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/lab/asset-uploads/{id}/complete',
      operationId: 'completeAssetUpload',
      tags: ['Lab'],
      request: { params: z.object({ id: z.string() }), headers: csrf },
      responses: { 200: json(LabAsset), ...errors },
    }),
    async (c) =>
      c.json(
        await completeAssetUpload(
          files,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').id,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/assets/{id}',
      operationId: 'getLabAsset',
      tags: ['Lab'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(LabAsset), ...readErrors },
    }),
    async (c) =>
      c.json(
        await getAsset(
          files,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').id,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/assets/{id}/download',
      operationId: 'getLabAssetDownload',
      tags: ['Lab'],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(DownloadCapability), ...readErrors },
    }),
    async (c) =>
      c.json(
        await downloadAsset(
          files,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').id,
        ),
        200,
      ),
  );
  app.use('/api/v1/lab/asset-uploads', async (c, next) => {
    if (c.req.method === 'POST') await boundedJson(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/lab/asset-uploads',
      operationId: 'startAssetUpload',
      tags: ['Lab'],
      request: {
        headers: z.object({
          'x-csrf-token': z
            .string()
            .optional()
            .openapi({
              param: { name: 'x-csrf-token', in: 'header', required: true },
            }),
          'idempotency-key': z
            .string()
            .optional()
            .openapi({
              param: { name: 'idempotency-key', in: 'header', required: true },
            }),
        }),
        body: {
          required: true,
          content: { 'application/json': { schema: CreateAssetUpload } },
        },
      },
      responses: {
        201: json(UploadCapability),
        400: json(ApiErrorResponse),
        401: json(ApiErrorResponse),
        403: json(ApiErrorResponse),
        404: json(ApiErrorResponse),
        409: json(ApiErrorResponse),
        410: json(ApiErrorResponse),
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
      if (
        duplicateStructField(c.req.raw, Object.keys(CreateAssetUpload.shape)) ||
        duplicateStructField(c.req.raw, Object.keys(UploadInput.shape), [
          'file',
        ])
      )
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await startAssetUpload(
          files,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('json'),
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
}
