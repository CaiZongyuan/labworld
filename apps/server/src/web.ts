import { serveStatic } from '@hono/node-server/serve-static';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { createApp } from '../../../packages/server/src/core/system/routes.ts';

export async function hostWeb(
  app: ReturnType<typeof createApp>,
  directory: string,
) {
  if (!(await stat(join(directory, 'index.html'))).isFile())
    throw new Error('LAB_WORD_WEB_DIR must contain the built Web index.html');
  const document = serveStatic({ root: directory, path: 'index.html' });
  app.get(
    '*',
    async (context, next) => {
      const path = context.req.path;
      if (
        ['/api', '/objects', '/health'].some(
          (prefix) => path === prefix || path.startsWith(prefix + '/'),
        )
      )
        return context.notFound();
      await next();
    },
    serveStatic({ root: directory }),
    async (context, next) => {
      if (
        extname(context.req.path) ||
        context.req.path.startsWith('/assets/')
      ) {
        context.res = await context.notFound();
        return;
      }
      const result = await document(context, next);
      if (result) context.res = result;
    },
  );
}
