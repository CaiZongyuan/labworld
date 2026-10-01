# Module Boundaries

Lab Word reuses Core and Platform while keeping laboratory behavior separate. [ADR 0003](../adr/0003-static-example-composition.md)and [ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)record the target boundaries.

## Dependencies

```text
Application entry ──composes──> Universal shell + business contributions
Business Views ──────────────> SDK / Core / UI
SDK ─────────────────────────> Contracts
Business Application ────────> Core public capabilities / Platform
Platform ────────────────────> Infrastructure
```

Application entry points choose composition. Core and the universal shell do not import concrete businesses. Platform does not depend on Application. Knowledge is currently a reference domain; Lab will own 3D assets and equipment concepts.

## Current Public Interfaces

The [composition contract](../../packages/views/src/shell/app-contract.ts)declares pages, navigation, messages and default entry. [Assembly validation](../../packages/views/src/shell/app-contract.ts)rejects duplicate ids, conflicting/reserved routes and missing translations. TanStack Router stays in the Web adapter.

The [API entry](../../apps/api/src/lib.rs)composes Router and OpenAPI. Each Rust module declares table ownership in `module.json`; modules collaborate through public capabilities instead of accessing each other's tables. Business use cases own transactions; audit and jobs share the same connection where atomic commit is required.

## Validation And Limits

```bash
pnpm boundaries:check
pnpm typecheck
```

Static checks reject known dependency and ownership violations. They cannot establish dynamic SQL correctness, authorization or recovery. Observe those behaviors through HTTP and public capability checks; see the [testing strategy](../testing/strategy.md).

Independent businesses have distinct source ownership, not separate customer organizations. The application retains [one Organization per deployment](../adr/0001-single-organization-deployment.md). Complete historical example manifests and removal tools are absent from this copy; target architecture does not establish implemented commands.

Production Lab validation must cover import failure, resource disposal, fast switching and lazy loading. See [product scope](lab-word.md).
