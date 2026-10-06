import { createApp } from '../../../packages/server/src/core/system/routes.ts';
import { identityRoutes } from '../../../packages/server/src/core/identity/routes.ts';
import { organizationRoutes } from '../../../packages/server/src/core/organization/routes.ts';
import { apiKeyRoutes } from '../../../packages/server/src/core/api-keys/routes.ts';
import { auditRoutes } from '../../../packages/server/src/core/audit/routes.ts';
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
  organizationRoutes(app, context, policy);
  auditRoutes(app, context, policy);
  apiKeyRoutes(app, context, policy, [
    { id: 'profile:read', label: '读取自己的基本资料' },
    { id: 'lab:full', label: 'Lab full access / 实验室完整访问' },
  ]);
  return app;
}
