import { schemaVersion } from '../../platform/db/index.ts';
import type { FoundationContext } from '../../platform/context.ts';
export async function ready(context: FoundationContext, requestId: string) {
  return Promise.race([
    context.db.ready(requestId),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      timer.unref();
    }),
  ]);
}
export async function systemStatus(
  context: FoundationContext,
  requestId: string,
  version: string,
) {
  if (!(await ready(context, requestId))) return undefined;
  return {
    status: 'ok',
    service: 'labos-threejs-api',
    database: 'connected',
    schema_version: schemaVersion,
    version,
  };
}
