import { readFileSync } from 'node:fs';
import { coreApp } from './app.ts';
import { configuration } from './config.ts';
import type { FoundationContext } from '../../../packages/server/src/platform/context.ts';
import { assetRoutes } from '../../../packages/server/src/lab/assets/routes.ts';
import type { FileService } from '../../../packages/server/src/core/files/use-cases.ts';
import { worldRoutes } from '../../../packages/server/src/lab/world/routes.ts';
import type { WorldService } from '../../../packages/server/src/lab/world/use-cases.ts';
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
console.log(
  JSON.stringify(
    app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Lab Word Server', version },
    }),
    null,
    2,
  ),
);
