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
  identityRoutes(app, context, policy);
  return app;
}
