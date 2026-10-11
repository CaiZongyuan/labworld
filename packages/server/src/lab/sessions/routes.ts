import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import { boundedJsonAt } from '../../platform/http/json.ts';
import { duplicateStructField } from '../../platform/http/json-syntax.ts';
import { PublicFailure } from '../../platform/http/failure.ts';
import { loopback } from '../motion/fixture.ts';
import type { SimulationSessions } from './service.ts';
import {
  SceneInstallation,
  SceneInstallationPage,
  SimulationSession,
  SimulationSessionPage,
  CreateSceneInstallation,
  StartSimulationSession,
  SessionTransition,
  SessionViewerTicketRequest,
  SessionMotionTicket,
  PublisherAdmissionRequest,
  PublisherAdmission,
  SimulationSessionEvent,
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
  409: json(ApiErrorResponse),
  413: json(ApiErrorResponse),
  429: json(ApiErrorResponse),
  503: json(ApiErrorResponse),
};
const invalid = () => {
  throw new PublicFailure(
    400,
    'http.invalid_json',
    'Provide a valid JSON request',
  );
};
const validate = (result: { success: boolean }) => {
  if (!result.success) invalid();
  return undefined;
};
const body = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
});
const lab = z.object({ lab_id: z.string().uuid() }),
  scope = z.object({
    lab_id: z.string().uuid(),
    session_id: z.string().uuid(),
  });
export function sessionRoutes(
  app: ReturnType<typeof createApp>,
  sessions: SimulationSessions,
  peer: (c: Context) => string | undefined = () => undefined,
) {
  const root = '/api/v1/lab/labs/{lab_id}',
    base = root + '/sessions';
  for (const path of [
    '/api/v1/lab/labs/:lab_id/installations',
    '/api/v1/lab/labs/:lab_id/installations/*',
    '/api/v1/lab/labs/:lab_id/sessions',
    '/api/v1/lab/labs/:lab_id/sessions/*',
  ])
    app.use(path, async (c, next) => {
      if (c.req.method === 'POST') {
        if (
          !loopback(peer(c)) ||
          ['forwarded', 'x-forwarded-for', 'x-real-ip'].some((name) =>
            c.req.raw.headers.has(name),
          )
        )
          throw new PublicFailure(
            404,
            'lab.synthetic_session_unavailable',
            'Development synthetic Sessions require loopback',
          );
        if (!c.req.path.endsWith('/archive'))
          await boundedJsonAt(4096)(c, async () => {});
      }
      await next();
    });
  app.openapi(
    createRoute({
      method: 'get',
      path: root + '/installations',
      operationId: 'listLabSceneInstallations',
      tags: ['Lab'],
      request: { params: lab },
      responses: { 200: json(SceneInstallationPage), ...errors },
    }),
    async (c) =>
      c.json(
        await sessions.installations(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
        ),
        200,
      ),
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: root + '/installations',
      operationId: 'createLabSceneInstallation',
      tags: ['Lab'],
      request: { params: lab, body: body(CreateSceneInstallation) },
      responses: { 201: json(SceneInstallation), ...errors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['representation_id'])) invalid();
      return c.json(
        await sessions.install(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
          c.req.valid('json').representation_id,
        ),
        201,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: root + '/installations/{installation_id}/archive',
      operationId: 'archiveLabSceneInstallation',
      tags: ['Lab'],
      request: {
        params: z.object({
          lab_id: z.string().uuid(),
          installation_id: z.string().uuid(),
        }),
      },
      responses: { 204: { description: '' }, ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await sessions.archiveInstallation(
        c.req.raw.headers,
        c.get('requestId'),
        p.lab_id,
        p.installation_id,
      );
      return c.body(null, 204);
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base,
      operationId: 'listLabSimulationSessions',
      tags: ['Lab'],
      request: { params: lab },
      responses: { 200: json(SimulationSessionPage), ...errors },
    }),
    async (c) =>
      c.json(
        await sessions.list(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
        ),
        200,
      ),
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base,
      operationId: 'startLabSimulationSession',
      tags: ['Lab'],
      request: { params: lab, body: body(StartSimulationSession) },
      responses: { 201: json(SimulationSession), ...errors },
    }),
    async (c) => {
      if (
        duplicateStructField(c.req.raw, [
          'installation_id',
          'parameters',
          'machine_id',
        ])
      )
        invalid();
      return c.json(
        await sessions.start(
          c.req.raw.headers,
          c.get('requestId'),
          c.req.valid('param').lab_id,
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
      path: base + '/events',
      operationId: 'streamLabSimulationSessions',
      tags: ['Lab'],
      request: { params: lab },
      responses: {
        200: {
          description: 'Session lifecycle events; no motion frames.',
          content: { 'text/event-stream': { schema: SimulationSessionEvent } },
        },
        ...errors,
      },
    }),
    async (c) =>
      sessions.subscribe(
        c.req.raw.headers,
        c.get('requestId'),
        c.req.valid('param').lab_id,
      ),
    validate,
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{session_id}',
      operationId: 'getLabSimulationSession',
      tags: ['Lab'],
      request: { params: scope },
      responses: { 200: json(SimulationSession), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await sessions.get(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.session_id,
        ),
        200,
      );
    },
    validate,
  );
  const operations = {
    pause: 'pauseLabSimulationSession',
    resume: 'resumeLabSimulationSession',
    stop: 'stopLabSimulationSession',
    reset: 'resetLabSimulationSession',
  } as const;
  for (const action of ['pause', 'resume', 'stop', 'reset'] as const)
    app.openapi(
      createRoute({
        method: 'post',
        path: base + '/{session_id}/' + action,
        operationId: operations[action],
        tags: ['Lab'],
        request: { params: scope, body: body(SessionTransition) },
        responses: { 200: json(SimulationSession), ...errors },
      }),
      async (c) => {
        if (duplicateStructField(c.req.raw, ['expected_revision'])) invalid();
        const p = c.req.valid('param');
        return c.json(
          await sessions.transition(
            c.req.raw.headers,
            c.get('requestId'),
            p.lab_id,
            p.session_id,
            action,
            c.req.valid('json').expected_revision,
          ),
          200,
        );
      },
      validate,
    );
  app.openapi(
    createRoute({
      method: 'post',
      path: base + '/{session_id}/viewer-tickets',
      operationId: 'createLabSessionViewerTicket',
      tags: ['Lab'],
      request: { params: scope, body: body(SessionViewerTicketRequest) },
      responses: { 201: json(SessionMotionTicket), ...errors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['preferred_rate_hz'])) invalid();
      const p = c.req.valid('param');
      return c.json(
        await sessions.viewerTicket(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.session_id,
          c.req.valid('json').preferred_rate_hz,
        ),
        201,
      );
    },
    validate,
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: base + '/{session_id}/publisher-admissions',
      operationId: 'admitLabSessionPublisher',
      tags: ['Lab'],
      request: { params: scope, body: body(PublisherAdmissionRequest) },
      responses: { 201: json(PublisherAdmission), ...errors },
    }),
    async (c) => {
      if (duplicateStructField(c.req.raw, ['machine_id'])) invalid();
      const p = c.req.valid('param');
      return c.json(
        await sessions.admit(
          c.req.raw.headers,
          c.get('requestId'),
          p.lab_id,
          p.session_id,
          c.req.valid('json').machine_id,
        ),
        201,
      );
    },
    validate,
  );
}
