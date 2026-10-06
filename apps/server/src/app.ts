import { createApp } from '../../../packages/server/src/core/system/routes.ts';
import { identityRoutes } from '../../../packages/server/src/core/identity/routes.ts';
import type { FoundationContext } from '../../../packages/server/src/platform/context.ts';
import type { AuthPolicy } from '../../../packages/server/src/core/identity/domain.ts';
export function coreApp(
  context: FoundationContext,
  version: string,
  policy: AuthPolicy,
  log?: (entry: Record<string, unknown>) => void,
) {
  const app = createApp(context, version, log);
  // Core JSON/byte routes aggregate auth, controls and every DB phase. Foundation
  // routes/isolated M1 streaming fixtures retain their existing operation ownership.
  app.use('/api/v1/*', async (c, next) => {
    await context.db.operation(
      { id: c.get('requestId'), kind: 'request' },
      async () => {
        await next();
      },
    );
  });
  identityRoutes(app, context, policy);
  return app;
}
