# Project Structure

Before changing Lab Word, distinguish the application, shared capabilities and isolated preview. Production Lab integration awaits acceptance.

## Source Map

```text
apps/
  web/src/app-examples.tsx  Explicit business composition
  web/src/router.tsx        Web routing adapter
  api/src/lib.rs            HTTP Router and OpenAPI composition
  worker/src/main.rs        Background handlers and maintenance
  desktop/src/              Electron host and IPC
  docs/.vitepress/           Bilingual documentation site
crates/
  app/src/modules/          Identity, membership, jobs, files, knowledge
  platform/src/             Database, storage, mail, cache, telemetry
packages/
  views/src/shell/           Universal shell and composition contracts
  views/src/knowledge/       Knowledge views
  ui/src/                   Shared components and styles
  contracts/                Rust-generated API contracts
  sdk/                      Generated client
migrations/                 Explicit SQL migrations
scripts/                    Development, checks, builds, operations
docs/                       Content, ADRs and plans
```

The preview is versioned in `.scratch/lab-viewer/v1/` on `preview/lab-viewer-v1`. It is outside the production build. See the [preview guide](../guides/lab-viewer.md) for reproduction.

## Planned Lab Integration

The [assembly point](../../apps/web/src/app-examples.tsx)consumes business contributions; the [routing adapter](../../apps/web/src/router.tsx)connects them to the host. [app-contract.ts](../../packages/views/src/shell/app-contract.ts)declares contributions and [app-contract.ts](../../packages/views/src/shell/app-contract.ts)validates composition.

Model import, the 3D viewport and asset information belong to Lab. The universal shell does not know equipment. Composition selects the default entry after authentication; direct access to `/` keeps the universal home. This describes responsibilities; record production routing and lazy-loading acceptance separately.

## Check Boundaries

```bash
pnpm boundaries:check
pnpm typecheck
```

Run from the repository root. Boundary checks inspect package dependencies, Rust table ownership and infrastructure imports in pure Domain code. They do not provide complete example addition/removal tooling. See [development and validation](../testing/t01-feedback-loop.md)for source, behavior and permission checks.

Next, read [module boundaries](module-boundaries.md), then implement the accepted Lab experience.
