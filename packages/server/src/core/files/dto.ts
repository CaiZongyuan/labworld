import { z } from '@hono/zod-openapi';
import type { createApp } from '../system/routes.ts';
const instant = z.string().openapi({ format: 'date-time' });
const i64 = z.number().openapi({ type: 'integer', format: 'int64' });
export const UploadInput = z
  .object({
    file_name: z.string(),
    content_type: z.string(),
    size: i64.openapi({ minimum: 0 }),
    sha256: z.string(),
  })
  .strict()
  .openapi('UploadInput');
export const FileInfo = z
  .object({
    id: z.string(),
    file_name: z.string(),
    content_type: z.string(),
    size: i64,
    sha256: z.string(),
    created_at: instant,
    previewable: z.boolean(),
  })
  .openapi('FileInfo');
export const ObjectCapability = z
  .object({
    url: z.string(),
    method: z.string(),
    headers: z
      .record(z.string(), z.string())
      .openapi({ ...{ propertyNames: { type: 'string' as const } } }),
    expires_at: instant,
  })
  .openapi('ObjectCapability');
export const UploadCapability = z
  .object({
    upload_id: z.string(),
    state: z.string(),
    upload: z
      .union([ObjectCapability, z.null()])
      .openapi({}, { unionPreferredType: 'oneOf' })
      .optional(),
  })
  .openapi('UploadCapability');
export const DownloadCapability = ObjectCapability.extend({
  file: FileInfo,
}).openapi('DownloadCapability');
export function registerFileSchemas(app: ReturnType<typeof createApp>) {
  for (const [name, schema] of Object.entries({
    UploadInput,
    FileInfo,
    ObjectCapability,
    UploadCapability,
    DownloadCapability,
  }))
    app.openAPIRegistry.register(name, schema);
}
