// This separate test entrypoint is never registered by the production server.
import { run } from '../../apps/server/src/runtime.ts';
import { fixtureApp } from '../../packages/server/test/fixture-app.ts';
await run(fixtureApp);
