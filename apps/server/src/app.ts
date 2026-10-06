import { createApp } from '../../../packages/server/src/core/system/routes.ts';
import { identityRoutes } from '../../../packages/server/src/core/identity/routes.ts';
import { organizationRoutes } from '../../../packages/server/src/core/organization/routes.ts';
import { apiKeyRoutes } from '../../../packages/server/src/core/api-keys/routes.ts';
import { auditRoutes } from '../../../packages/server/src/core/audit/routes.ts';
import {
  LocalLimiter,
  defaultRateOptions,
  type RateOptions,
} from '../../../packages/server/src/core/rate-limit/domain.ts';
import { rateRoutes } from '../../../packages/server/src/core/rate-limit/routes.ts';
import { getConnInfo } from '@hono/node-server/conninfo';
import { PublicFailure } from '../../../packages/server/src/platform/http/failure.ts';
import { secretHash } from '../../../packages/server/src/platform/crypto.ts';
import type { FoundationContext } from '../../../packages/server/src/platform/context.ts';
import type { AuthPolicy } from '../../../packages/server/src/core/identity/domain.ts';
export function coreApp(
  context: FoundationContext,
  version: string,
  policy: AuthPolicy,
  log?: (entry: Record<string, unknown>) => void,
  rate: RateOptions = defaultRateOptions,
) {
  const started = performance.now(),
    anchor = Date.now();
  const limiter = new LocalLimiter(
    rate,
    () => anchor + performance.now() - started,
  );
  const app = createApp(context, version, log, (app) =>
    app.use('*', async (c, next) => {
      if (!rate.enabled) {
        await next();
        return;
      }
      const peer = getConnInfo(c).remote.address ?? 'unknown';
      const seconds = limiter.consume(
        c.req.method,
        c.req.path,
        secretHash(peer.startsWith('::ffff:') ? peer.slice(7) : peer).toString(
          'hex',
        ),
      );
      if (seconds !== undefined) {
        c.header('retry-after', String(seconds));
        throw new PublicFailure(
          429,
          'rate_limit.exceeded',
          'Request budget exceeded; retry later',
          { retry_after_seconds: String(seconds) },
        );
      }
      await next();
    }),
  );
  // Core JSON/byte routes aggregate auth, controls and every DB phase. Foundation
  // routes/isolated M1 streaming fixtures retain their existing operation ownership.
  for (const path of ['/api/v1/*', '/objects/*'])
    app.use(path, async (c, next) => {
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
  rateRoutes(app, context, policy, limiter);
  apiKeyRoutes(app, context, policy, [
    { id: 'profile:read', label: '读取自己的基本资料' },
    { id: 'lab:full', label: 'Lab full access / 实验室完整访问' },
  ]);
  return app;
}
