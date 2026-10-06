import { readFileSync } from 'node:fs';
import { createApp } from '../../../packages/server/src/core/system/routes.ts';
import type { FoundationContext } from '../../../packages/server/src/platform/context.ts';
// Schema generation does not open a DB. Handler context is unreachable here.
const version = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
const app = createApp(
  undefined as unknown as FoundationContext,
  version,
  () => {},
);
console.log(
  JSON.stringify(
    app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Lab Word Server (M1 foundation)', version },
    }),
    null,
    2,
  ),
);
