import { readFileSync } from 'node:fs';
import { coreApp } from './app.ts';
import { configuration } from './config.ts';
import type { FoundationContext } from '../../../packages/server/src/platform/context.ts';
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
