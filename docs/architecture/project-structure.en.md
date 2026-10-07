# Project structure

Lab Word runs one TypeScript service and a Web application. Persistent Labs, assets, layouts, device programs, observations, records and trends use the shared Member/Agent HTTP contract.

```text
apps/
  server/src/              Node service, CLI and lifecycle composition
  web/src/app.ts           Direct Lab application configuration
  web/src/router.tsx       Web routing adapter
  desktop/src/             Shared Electron shell source
  docs/.vitepress/         Bilingual documentation site
packages/
  server/src/platform/     Embedded DB, local bytes and HTTP adapters
  server/src/core/         Identity, members, keys, files, audit and limits
  server/src/lab/          Assets, World, Devices, History and Records
  views/src/lab/           Workbench, assets and 3D views
  views/src/shell/         Shared navigation, preferences and messages
  ui/src/                  Shared components and styles
  contracts/               Node-generated OpenAPI and TypeScript DTOs
  sdk/                     Generated HTTP client and Lab SSE transport
scripts/                   Development, checks, builds and operations
docs/                      Guides, domain vocabulary and decisions
```

The [application entry](../../apps/web/src/app.ts) imports the [Lab application](../../packages/views/src/lab/app.tsx) directly. Its [router](../../apps/web/src/router.tsx) supplies navigation and API-client ports. The [shell interface](../../packages/views/src/shell/app-contract.ts) describes pages, navigation and bilingual messages. Lab opens after login; `/` remains the shared home. Heavy views and 3D code load on demand.

The [runtime](../../apps/server/src/runtime.ts) owns service initialization and shutdown. Database drivers and migrations stay in [platform/db](../../packages/server/src/platform/db/index.ts). Platform Core does not import Lab. Web uses the generated SDK; server database code never enters the Web bundle. Frozen Rust and infrastructure sources remain temporarily until the migration cleanup ticket; they are outside ordinary startup and official contract generation.

```bash
pnpm boundaries:check
pnpm typecheck
```

Run from the repository root. Boundary checks cover package dependencies and the TypeScript service, while the frozen Rust ownership check remains until cleanup. See [development and validation](../testing/t01-feedback-loop.md), [module boundaries](module-boundaries.md) and the [Lab guide](../guides/lab-viewer.md).
