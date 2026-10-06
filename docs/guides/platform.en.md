# Existing platform capabilities

Choose the real interfaces for current Lab Word Platform Core. Start the Node service with [service foundation](server-foundation.md). Development needs no Docker, Rust or external database.

```bash
curl -i http://127.0.0.1:3000/api/v1/auth/session
curl -i http://127.0.0.1:3000/api/openapi.json
```

Anonymous session returns 401. OpenAPI returns JSON for migrated endpoints with the title `Lab Word Server`. See identity, memberships, API keys, audit, idempotency, limits and files in the [platform guide](server-platform.md). See byte storage and business references in the [file guide](server-files.md). Lab assets, world writes and device programs remain in migration.

Core does not import Lab. Core owns role management. [ADR 0008](../adr/0008-full-lab-access-for-users-and-agents.md) defines full Lab access for users and valid `lab:full` Agents. Lab owns its business validator, references and publication callback.

The generated [API](site:reference/api.md) and [configuration](site:reference/config.md) separate current Node content from the frozen legacy stack. Rust modules, Docker configuration and the complete SDK remain temporarily. They are not runtime dependencies of `pnpm dev`. Removal follows the complete migration gate. The final switch is still pending.

Run `pnpm test:server` from the repository root for real Node HTTP, capabilities and transaction recovery. Frontend tests use MSW at HTTP. They do not prove storage integration. Choose affected interfaces with the [testing guide](../testing/t01-feedback-loop.md). Node backups and the complete release path remain in later stages.
