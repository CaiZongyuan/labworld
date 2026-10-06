import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { boundedJson, boundedJsonAt } from '../../platform/http/json.ts';
import {
  duplicateStructField,
  invalidI64Field,
} from '../../platform/http/json-syntax.ts';
import type { WorldService } from './use-cases.ts';
import {
  PersistentLab,
  LabPage,
  CreateLab,
  LabWorld,
  LabEntity,
  RegisterEntity,
  ConfigureEntity,
  AssetDefinition,
  SceneNode,
  CreateSceneNode,
  CopyLabEntity,
  SaveLabLayout,
  LabLayout,
} from './dto.ts';
import type { Placement } from './domain.ts';
import { saveLayout } from './layout.ts';
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
  503: json(ApiErrorResponse),
  429: {
    ...json(ApiErrorResponse),
    description: 'Request budget exceeded; retry after the specified seconds',
    headers: { 'Retry-After': { schema: { type: 'integer' as const } } },
  },
};
const ordinaryErrors = {
  400: errors[400],
  401: errors[401],
  403: errors[403],
  404: errors[404],
  429: errors[429],
  503: errors[503],
};
export function worldRoutes(
  app: ReturnType<typeof createApp>,
  world: WorldService,
) {
  const layoutJson = boundedJsonAt(512 * 1024);
  app.use('/api/v1/lab/labs/:lab_id/layout', async (c, next) => {
    if (c.req.method === 'PUT') await layoutJson(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/lab/labs/{lab_id}/layout',
      operationId: 'saveLabLayout',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: SaveLabLayout } },
        },
      },
      responses: { 200: json(LabLayout), ...errors },
    }),
    async (c) => {
      const input = c.req.valid('json');
      if (
        invalidI64Field(c.req.raw, 'expected_version') ||
        duplicateStructField(c.req.raw, Object.keys(SaveLabLayout.shape)) ||
        input.nodes.some(
          (_, index) =>
            duplicateStructField(
              c.req.raw,
              ['id', 'entity_id', 'representation_id', 'placement'],
              ['nodes', index],
            ) ||
            duplicateStructField(
              c.req.raw,
              ['position', 'rotation', 'scale'],
              ['nodes', index, 'placement'],
            ),
        ) ||
        input.relationships?.some((_, index) =>
          duplicateStructField(
            c.req.raw,
            ['id', 'source_id', 'target_id', 'kind'],
            ['relationships', index],
          ),
        )
      )
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await saveLayout(
          world.context,
          world.policy,
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
          {
            ...input,
            nodes: input.nodes.map((node) => ({
              ...node,
              placement: node.placement as Placement,
            })),
          },
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
  app.use('/api/v1/lab/labs/:lab_id/nodes', async (c, next) => {
    if (c.req.method === 'POST') await boundedJson(c, async () => {});
    await next();
  });
  app.use(
    '/api/v1/lab/labs/:lab_id/entities/:entity_id/copies',
    async (c, next) => {
      if (c.req.method === 'POST') await boundedJson(c, async () => {});
      await next();
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/lab/labs/{lab_id}/nodes',
      operationId: 'createLabSceneNode',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: CreateSceneNode } },
        },
      },
      responses: { 201: json(SceneNode), ...ordinaryErrors },
    }),
    async (c) => {
      if (
        duplicateStructField(c.req.raw, Object.keys(CreateSceneNode.shape)) ||
        duplicateStructField(
          c.req.raw,
          ['position', 'rotation', 'scale'],
          ['placement'],
        )
      )
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      const input = c.req.valid('json');
      return c.json(
        await world.createNode(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
          { ...input, placement: input.placement as Placement },
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
      path: '/api/v1/lab/labs/{lab_id}/entities/{entity_id}/copies',
      operationId: 'copyLabEntity',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string(), entity_id: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: CopyLabEntity } },
        },
      },
      responses: { 201: json(LabEntity), ...errors },
    }),
    async (c) => {
      if (
        invalidI64Field(c.req.raw, 'expected_version') ||
        duplicateStructField(c.req.raw, Object.keys(CopyLabEntity.shape)) ||
        duplicateStructField(
          c.req.raw,
          ['position', 'rotation', 'scale'],
          ['placement'],
        )
      )
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      const p = c.req.valid('param'),
        input = c.req.valid('json');
      return c.json(
        await world.copy(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
          { ...input, placement: input.placement as Placement },
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
  const definitionPage = z
    .object({ data: z.array(AssetDefinition) })
    .openapi('DefinitionPage');
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/asset-definitions',
      operationId: 'listAssetDefinitions',
      tags: ['Lab'],
      responses: {
        200: json(definitionPage),
        401: errors[401],
        403: errors[403],
        503: errors[503],
        429: errors[429],
      },
    }),
    async (c) =>
      c.json(
        await world.definitions(c.req.raw.headers, c.get('requestId')),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/asset-definitions/{id}/{version}',
      operationId: 'getAssetDefinition',
      tags: ['Lab'],
      request: { params: z.object({ id: z.string(), version: z.string() }) },
      responses: {
        200: json(AssetDefinition),
        401: errors[401],
        403: errors[403],
        404: errors[404],
        503: errors[503],
        429: errors[429],
      },
    }),
    async (c) =>
      c.json(
        await world.definitions(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').id,
          c.req.valid('param').version,
        ),
        200,
      ),
  );
  app.use('/api/v1/lab/labs/:lab_id/entities', async (c, next) => {
    if (c.req.method === 'POST') await boundedJson(c, async () => {});
    await next();
  });
  app.use('/api/v1/lab/labs/:lab_id/entities/:entity_id', async (c, next) => {
    if (c.req.method === 'PATCH') await boundedJson(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/lab/labs/{lab_id}/entities',
      operationId: 'registerLabEntity',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: RegisterEntity } },
        },
      },
      responses: { 201: json(LabEntity), ...ordinaryErrors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, Object.keys(RegisterEntity.shape)))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await world.register(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
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
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/lab/labs/{lab_id}/entities/{entity_id}',
      operationId: 'getLabEntity',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string(), entity_id: z.string() }),
      },
      responses: {
        200: {
          ...json(LabEntity),
          headers: {
            'X-Lab-Runtime': {
              schema: { type: 'string' },
              description:
                'ready or unavailable: immediate execution service status. Combine with persistent capability permission.',
            },
          },
        },
        ...ordinaryErrors,
      },
    }),
    async (c) => {
      c.header('x-lab-runtime', 'unavailable');
      const p = c.req.valid('param');
      return c.json(
        await world.entity(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/lab/labs/{lab_id}/entities/{entity_id}',
      operationId: 'configureLabEntity',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string(), entity_id: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: ConfigureEntity } },
        },
      },
      responses: { 200: json(LabEntity), ...ordinaryErrors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, Object.keys(ConfigureEntity.shape)))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      const p = c.req.valid('param');
      return c.json(
        await world.configure(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.entity_id,
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
      path: '/api/v1/lab/labs',
      operationId: 'listLabs',
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
        200: json(LabPage),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        503: errors[503],
        429: errors[429],
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      if (query.limit !== undefined && !/^\d+$/.test(query.limit))
        throw new PublicFailure(
          400,
          'http.invalid_query',
          'Query parameters are invalid',
        );
      return c.json(
        await world.list(c.req.raw.headers, c.get('requestId'), {
          limit: query.limit === undefined ? undefined : Number(query.limit),
          cursor: query.cursor,
        }),
        200,
      );
    },
  );
  app.use('/api/v1/lab/labs', async (c, next) => {
    if (c.req.method === 'POST') await boundedJson(c, async () => {});
    await next();
  });
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/lab/labs',
      operationId: 'createLab',
      tags: ['Lab'],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: CreateLab } },
        },
      },
      responses: {
        201: json(PersistentLab),
        400: errors[400],
        401: errors[401],
        403: errors[403],
        503: errors[503],
        429: errors[429],
      },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['name']))
        throw new PublicFailure(
          400,
          'http.invalid_json',
          'Provide a valid JSON request',
        );
      return c.json(
        await world.create(
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
      method: 'get',
      path: '/api/v1/lab/labs/{lab_id}/world',
      operationId: 'getLabWorld',
      tags: ['Lab'],
      request: {
        params: z.object({ lab_id: z.string() }),
        query: z.object({
          kind: z.string().optional(),
          capability: z.string().optional(),
          state: z.string().optional(),
        }),
      },
      responses: {
        200: {
          ...json(LabWorld),
          headers: {
            'X-Lab-Runtime': {
              schema: { type: 'string' },
              description:
                'ready or unavailable: immediate execution service status. Combine with persistent capability permission; this header is outside the world version.',
            },
          },
        },
        ...ordinaryErrors,
      },
    }),
    async (c) => {
      c.header('x-lab-runtime', 'unavailable');
      return c.json(
        await world.world(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
          c.req.valid('query'),
        ),
        200,
      );
    },
  );
}
