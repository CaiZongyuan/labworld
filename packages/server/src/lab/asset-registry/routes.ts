import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { boundedJsonAt } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import {
  CompleteAssetVersion,
  ImportAssetVersion,
  AssetVersionPage,
} from './dto.ts';
import {
  UploadInput,
  UploadCapability,
  FileInfo,
  DownloadCapability,
} from '../../core/files/dto.ts';
import type { AssetRegistry } from './service.ts';
const json = (schema: z.ZodType) => ({
  description: '',
  content: { 'application/json': { schema } },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 422, 429, 503].map((status) => [
    status,
    json(ApiErrorResponse),
  ]),
);
const validate = (result: { success: boolean }) => {
  if (!result.success)
    throw new PublicFailure(
      400,
      'lab.invalid_asset_description',
      'Provide a valid asset description',
    );
  return undefined;
};
export function assetRegistryRoutes(
  app: ReturnType<typeof createApp>,
  registry: AssetRegistry,
) {
  const base = '/api/v1/lab/asset-versions';
  app.use(base, async (c, next) => {
    if (c.req.method === 'POST')
      await boundedJsonAt(192 * 1024)(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: base,
      operationId: 'importCompleteAssetVersion',
      tags: ['Lab'],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: ImportAssetVersion } },
        },
      },
      responses: { 201: json(CompleteAssetVersion), ...errors },
    }),
    async (c) => {
      if (
        duplicateStructField(c.req.raw, Object.keys(ImportAssetVersion.shape))
      )
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await registry.publish(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('json'),
        ),
        201,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{version_id}',
      operationId: 'getCompleteAssetVersion',
      tags: ['Lab'],
      request: { params: z.object({ version_id: z.string().uuid() }) },
      responses: { 200: json(CompleteAssetVersion), ...errors },
    }),
    async (c) =>
      c.json(
        await registry.get(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').version_id,
        ),
        200,
      ),
    validate,
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base,
      operationId: 'listCompleteAssetVersions',
      tags: ['Lab'],
      request: {
        query: z.object({
          asset_id: z.string().max(256).optional(),
          version: z.string().max(80).optional(),
          cursor: z.string().uuid().optional(),
          limit: z.string().regex(/^\d+$/).optional(),
        }),
      },
      responses: { 200: json(AssetVersionPage), ...errors },
    }),
    async (c) => {
      const query = c.req.valid('query');
      return c.json(
        await registry.list(c.req.raw.headers, c.get('requestId'), {
          ...query,
          limit: query.limit === undefined ? undefined : Number(query.limit),
        }),
        200,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{version_id}/resources/{resource_key}/download',
      operationId: 'downloadAssetVersionResource',
      tags: ['Lab'],
      request: {
        params: z.object({
          version_id: z.string().uuid(),
          resource_key: z.string(),
        }),
      },
      responses: { 200: json(DownloadCapability), ...errors },
    }),
    async (c) => {
      const params = c.req.valid('param');
      return c.json(
        await registry.download(
          c.req.raw.headers,
          c.get('requestId'),
          params.version_id,
          params.resource_key,
        ),
        200,
      );
    },
    validate,
  );
  const uploads = '/api/v1/lab/asset-resource-uploads';
  app.use(uploads, async (c, next) => {
    if (c.req.method === 'POST') await boundedJsonAt(4096)(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: uploads,
      operationId: 'startAssetResourceUpload',
      tags: ['Lab'],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: UploadInput } },
        },
      },
      responses: { 201: json(UploadCapability), ...errors },
    }),
    async (c) =>
      c.json(
        await registry.startResource(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('json'),
        ),
        201,
      ),
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: uploads + '/{upload_id}/complete',
      operationId: 'completeAssetResourceUpload',
      tags: ['Lab'],
      request: { params: z.object({ upload_id: z.string().uuid() }) },
      responses: { 200: json(FileInfo), ...errors },
    }),
    async (c) =>
      c.json(
        await registry.completeResource(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').upload_id,
        ),
        200,
      ),
    validate,
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: uploads + '/{upload_id}',
      operationId: 'cancelAssetResourceUpload',
      tags: ['Lab'],
      request: { params: z.object({ upload_id: z.string().uuid() }) },
      responses: { 204: { description: '' }, ...errors },
    }),
    async (c) => {
      await registry.cancelResource(
        c.req.raw.headers,
        c.get('requestId'),
        c.req.valid('param').upload_id,
      );
      return c.body(null, 204);
    },
    validate,
  );
}
