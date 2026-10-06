import type { createApp } from '../system/routes.ts';
import type { FileService } from './use-cases.ts';
async function* requestBytes(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export function fileRoutes(
  app: ReturnType<typeof createApp>,
  files: FileService,
) {
  app.put('/objects/:id', async (c) => {
    await files.upload(
      c.req.param('id'),
      new URL(c.req.url).searchParams,
      c.req.header('content-type') ?? '',
      requestBytes(c.req.raw.body),
      c.get('requestId'),
    );
    return c.body(null, 204);
  });
  app.get('/objects/:id', async (c) => {
    const download = await files.signedDownload(
      c.req.param('id'),
      new URL(c.req.url).searchParams,
      c.get('requestId'),
    );
    const iterator = download.bytes[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await iterator.next();
          if (item.done) controller.close();
          else controller.enqueue(item.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    return c.body(stream, 200, {
      'content-type': download.contentType,
      'content-length': String(download.size),
      'content-disposition': 'attachment',
      'cache-control': 'no-store',
    });
  });
}
