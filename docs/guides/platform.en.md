# Existing Platform Capabilities

Goal: reuse existing platform interfaces when developing Lab Word and understand their boundary with laboratory behavior. Complete [quick start](../getting-started/quickstart.md)first.

## Start With Real Interfaces

```bash
curl -i http://127.0.0.1:3000/api/v1/auth/session
curl -i http://127.0.0.1:3000/api/openapi.json
```

An anonymous session request should return 401; OpenAPI should return JSON identifying `Lab Word API`. Signed-in views use Session through the SDK. Business mutations retain trusted Origin and CSRF checks; visible client controls do not replace server authorization.

## Source And Responsibilities

| Capability                             | Public source                                                                                                                                                            | Lab responsibility                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Registration, sessions, password reset | [Identity](../../crates/app/src/modules/identity/mod.rs)                                                                                                                 | Reuse User and Session                                        |
| Organization membership and roles      | [Organization](../../crates/app/src/modules/organization/mod.rs)                                                                                                         | Define equipment resource access                              |
| Files and cleanup                      | [Files](../../crates/app/src/modules/files/mod.rs)                                                                                                                       | Define future asset ownership; M0 local imports do not upload |
| Jobs, audit, notifications             | [Jobs](../../crates/app/src/modules/jobs/mod.rs), [Audit](../../crates/app/src/modules/audit/mod.rs), [Notifications](../../crates/app/src/modules/notifications/mod.rs) | Define handlers, audit semantics and notification targets     |
| Knowledge base                         | [Knowledge](../../crates/app/src/modules/knowledge/mod.rs)                                                                                                               | Keep existing behavior separate from equipment models         |

Read the [generated API](site:reference/api.md)for operations and responses and [configuration](site:reference/config.md)for settings. Platform capabilities do not imply implemented telemetry, IoT integration or equipment control.

## Validate Failure Boundaries

Run from the repository root:

```bash
node scripts/test-backend.mjs --test registration --test sessions
pnpm test:frontend
```

Backend checks start isolated services and verify registration, sessions, rejection and invalidation with real dependencies; Docker is required. Frontend checks use MSW at HTTP and do not prove database or storage integration. Choose relevant checks with the [testing guide](../testing/t01-feedback-loop.md).

## Operations

[compose.production.yaml](../../compose.production.yaml)defines existing deployment, with [env.production.example](../../deploy/production/env.production.example)as the configuration example. [justfile](../../justfile)provides explicit migration, deployment, backup and isolated restore commands. Inspect current scripts and settings first; this page does not claim a production Lab release exists.
