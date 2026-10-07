# Existing platform capabilities

Choose the real interfaces for current Lab Word Platform Core. Start the Node service with [service foundation](server-foundation.md). Development needs no Docker, Rust or external database.

```bash
curl -i http://127.0.0.1:3000/api/v1/auth/session
curl -i http://127.0.0.1:3000/api/openapi.json
```

Anonymous session returns 401. OpenAPI returns the complete retained Node contract with the title `Lab Word API`. See identity, memberships, API keys, audit, idempotency, limits and files in the [platform guide](server-platform.md). See byte storage and business references in the [file guide](server-files.md). Lab assets, World writes and device programs use this service.

Core does not import Lab. Core owns role management. [ADR 0008](../adr/0008-full-lab-access-for-users-and-agents.md) defines full Lab access for users and valid `lab:full` Agents. Lab owns its business validator, references and publication callback.

The generated [API](site:reference/api.md) and [configuration](site:reference/config.md) come from the official Node source. Retired Rust and deployment source is preserved at `legacy-rust-final`. Current source, commands and the official SDK use Node. Final CI and integration determine Migration Gate completion.

Run `pnpm test:server` from the repository root for real Node HTTP, capabilities and transaction recovery. Frontend tests use MSW at HTTP. They do not prove storage integration. Choose affected interfaces with the [testing guide](../testing/t01-feedback-loop.md). See [operations](server-operations.md) for backup/restore/password recovery and [Web hosting](server-web.md) for production same-origin access.
