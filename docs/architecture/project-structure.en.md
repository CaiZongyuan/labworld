# Project Structure

Before changing Lab Word, distinguish the application, shared capabilities and isolated preview. Lab Viewer and the session-local Asset Library are integrated. Foundation V1's persistent world and server-owned devices continue through the published implementation tickets.

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
  views/src/lab/             Viewer, session-local catalog and Lab contribution
  views/src/shell/           Universal shell and composition contracts
  views/src/knowledge/       Knowledge views
  ui/src/                   Shared components and styles
  contracts/                Rust-generated API contracts
  sdk/                      Generated client
migrations/                 Explicit SQL migrations
scripts/                    Development, checks, builds, operations
docs/                       Content, ADRs and plans
```

See the [viewer guide](../guides/lab-viewer.md) for the current application. The accepted Foundation v1 preview is preserved on the separate `preview/lab-foundation-v1` branch; the [developer handoff](../handoffs/digital-twin-foundation-v1.md) explains how to obtain and run it. It is outside the production build.

## Lab Integration Points

The [assembly point](../../apps/web/src/app-examples.tsx)consumes business contributions; the [routing adapter](../../apps/web/src/router.tsx)connects them to the host. [app-contract.ts](../../packages/views/src/shell/app-contract.ts)declares contributions and [app-contract.ts](../../packages/views/src/shell/app-contract.ts)validates composition.

Model import, the 3D viewport and asset information belong to Lab. The universal shell does not know equipment. Lab contributes `/lab` and `/assets`, and composition selects Lab after authentication; direct access to `/` keeps the universal home. Existing pages and 3D code are lazy-loaded. Foundation work must preserve these responsibilities.

## Check Boundaries

```bash
pnpm boundaries:check
pnpm typecheck
```

Run from the repository root. Boundary checks inspect package dependencies, Rust table ownership and infrastructure imports in pure Domain code. They do not provide complete example addition/removal tooling. See [development and validation](../testing/t01-feedback-loop.md)for source, behavior and permission checks.

Next, read [module boundaries](module-boundaries.md), then implement the accepted Lab experience.
