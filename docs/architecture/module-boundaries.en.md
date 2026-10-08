# Module boundaries

Lab owns laboratory behavior. Platform Core owns identity, members, keys, files, audit, idempotency and limits. Core does not import Lab. The Node application composes them through public capabilities, as recorded in [ADR 0010](../adr/0010-single-typescript-lab-word-server.md) and [ADR 0011](../adr/0011-pglite-embedded-database.md).

The [application entry](../../apps/web/src/app.ts) supplies Lab's routes, navigation and messages to the shared shell. The [router](../../apps/web/src/router.tsx) owns TanStack types and browser navigation. Heavy views stay lazy. Web consumes generated SDK/DTOs; database code does not enter its bundle.

The [runtime](../../apps/server/src/runtime.ts) composes service owners. Database drivers and migration execution belong only to platform/db. Pure domains cannot import infrastructure. Business use cases own transactions; Core audit and idempotency commit with the same business operation.

[Node schema declarations](../../packages/server/src/lab/world/schema.ts) own qualified tables. [Lab ownership](../../packages/server/src/lab/ownership.json) records its Views path, exact SDK helper paths and contract symbols. [Boundary checks](../../scripts/check-boundaries.mjs) validate package imports, Node table declarations/migrations and the SDK/Core restrictions. [Server checks](../../scripts/lib/server-boundaries.mjs) follow transitive Core/domain dependencies. Static checks do not prove authorization, dynamic SQL or recovery.

```bash
pnpm boundaries:check
pnpm typecheck
```

Run from the repository root. Use HTTP/browser and controlled ownership checks for behavior. See [testing](../testing/strategy.md) and [product scope](lab-word.md). Historical static-example architecture remains recorded in earlier ADRs; it is not an active removal or composition framework.
