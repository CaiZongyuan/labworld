import { createRoute, z } from '@hono/zod-openapi';
import type { createApp } from '../../core/system/routes.ts';
import { ApiErrorResponse } from '../../platform/http/errors.ts';
import type { RecordingService } from './service.ts';
import {
  LabRecording,
  LabRecordingPage,
  RecordingManifest,
  RecordingSegmentPage,
  RecordingEventPage,
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
const base = '/api/v1/lab/labs/{lab_id}/recordings';
const lab = z.object({ lab_id: z.string().uuid() }),
  scope = lab.extend({ recording_id: z.string().uuid() }),
  query = z.object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
export function recordingRoutes(
  app: ReturnType<typeof createApp>,
  recordings: RecordingService,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: base,
      operationId: 'listLabRecordings',
      tags: ['Lab'],
      request: { params: lab, query },
      responses: { 200: json(LabRecordingPage), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param'),
        q = c.req.valid('query');
      return c.json(
        await recordings.list(c.req.raw.headers, p.lab_id, q.cursor, q.limit),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{recording_id}',
      operationId: 'getLabRecording',
      tags: ['Lab'],
      request: { params: scope },
      responses: { 200: json(LabRecording), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await recordings.get(c.req.raw.headers, p.lab_id, p.recording_id),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{recording_id}/manifest',
      operationId: 'getLabRecordingManifest',
      tags: ['Lab'],
      request: { params: scope },
      responses: { 200: json(RecordingManifest), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await recordings.manifest(c.req.raw.headers, p.lab_id, p.recording_id),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{recording_id}/segments',
      operationId: 'listLabRecordingSegments',
      tags: ['Lab'],
      request: { params: scope, query },
      responses: { 200: json(RecordingSegmentPage), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param'),
        q = c.req.valid('query');
      return c.json(
        await recordings.segments(
          c.req.raw.headers,
          p.lab_id,
          p.recording_id,
          q.cursor,
          q.limit,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{recording_id}/events',
      operationId: 'listLabRecordingEvents',
      tags: ['Lab'],
      request: { params: scope, query },
      responses: { 200: json(RecordingEventPage), ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param'),
        q = c.req.valid('query');
      return c.json(
        await recordings.events(
          c.req.raw.headers,
          p.lab_id,
          p.recording_id,
          q.cursor,
          q.limit,
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: base + '/{recording_id}/segments/{segment_id}',
      operationId: 'getLabRecordingSegment',
      tags: ['Lab'],
      request: { params: scope.extend({ segment_id: z.string().uuid() }) },
      responses: {
        200: {
          description: 'Verified bounded LWF1 journal segment.',
          content: {
            'application/vnd.lab-word.recording-segment': {
              schema: z.string().openapi({ format: 'binary' }),
            },
          },
        },
        ...errors,
      },
    }),
    async (c) => {
      const p = c.req.valid('param'),
        read = await recordings.segment(
          c.req.raw.headers,
          p.lab_id,
          p.recording_id,
          p.segment_id,
        ),
        iterator = read.bytes[Symbol.asyncIterator]();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
              await iterator.return?.();
            }
          },
          async cancel() {
            await iterator.return?.();
          },
        }),
        {
          headers: {
            'content-type': 'application/vnd.lab-word.recording-segment',
            'content-length': String(read.size),
            'cache-control': 'no-store',
          },
        },
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: base + '/{recording_id}',
      operationId: 'deleteLabRecording',
      tags: ['Lab'],
      request: { params: scope },
      responses: { 204: { description: '' }, ...errors },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await recordings.delete(c.req.raw.headers, p.lab_id, p.recording_id);
      return c.body(null, 204);
    },
  );
}
