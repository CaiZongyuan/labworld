import { readFileSync } from 'node:fs';
import { coreApp } from './app.ts';
import { configuration } from './config.ts';
import type { FoundationContext } from '../../../packages/server/src/platform/context.ts';
import { assetRoutes } from '../../../packages/server/src/lab/assets/routes.ts';
import type { FileService } from '../../../packages/server/src/core/files/use-cases.ts';
import { worldRoutes } from '../../../packages/server/src/lab/world/routes.ts';
import { progressRoutes } from '../../../packages/server/src/lab/progress/routes.ts';
import type { ProgressService } from '../../../packages/server/src/lab/progress/use-cases.ts';
import type { WorldService } from '../../../packages/server/src/lab/world/use-cases.ts';
import { deviceRoutes } from '../../../packages/server/src/lab/devices/routes.ts';
import type { DeviceService } from '../../../packages/server/src/lab/devices/use-cases.ts';
import { subscriptionRoutes } from '../../../packages/server/src/lab/world/subscription-routes.ts';
import type { WorldSubscriptions } from '../../../packages/server/src/lab/world/subscriptions.ts';
import { historyRoutes } from '../../../packages/server/src/lab/history/routes.ts';
import type { HistoryService } from '../../../packages/server/src/lab/history/use-cases.ts';
import { recordsRoutes } from '../../../packages/server/src/lab/records/routes.ts';
import type { RecordsService } from '../../../packages/server/src/lab/records/use-cases.ts';
import { trendRoutes } from '../../../packages/server/src/lab/history/trend-routes.ts';
import { lifecycleRoutes } from '../../../packages/server/src/lab/world/lifecycle-routes.ts';
// Schema generation does not open a DB. Handler context is unreachable here.
const version = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
const app = coreApp(
  undefined as unknown as FoundationContext,
  version,
  configuration().auth,
  () => {},
);
assetRoutes(app, undefined as unknown as FileService);
worldRoutes(app, undefined as unknown as WorldService);
progressRoutes(app, undefined as unknown as ProgressService);
lifecycleRoutes(app, undefined as unknown as WorldService);
deviceRoutes(app, undefined as unknown as DeviceService);
subscriptionRoutes(app, undefined as unknown as WorldSubscriptions);
historyRoutes(app, undefined as unknown as HistoryService);
recordsRoutes(app, undefined as unknown as RecordsService);
trendRoutes(app, undefined as unknown as HistoryService);
const document = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: {
    title: 'Lab Word API',
    description: '',
    license: { name: '' },
    version,
  },
});
delete document.webhooks;
console.log(JSON.stringify(document, null, 2));
