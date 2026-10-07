# Replay the migration contract baseline

This guide is for developers who migrate the Lab Word service. M0 replays delivered Core, Foundation #2–#11, and #26–#28 behavior against real Rust HTTP/SSE. The new TypeScript service does not exist yet. Product behavior in #29–#40 is outside this baseline.

## Get the first result

Run these commands at the repository root. Use the repository Node, pnpm, and Rust versions. Docker must be available.

```bash
pnpm install --frozen-lockfile
pnpm test:contract core.test.ts
```

Build the Node service first. The runner starts that compiled entry with an isolated data directory and creates the first Owner through HTTP. The service owns its embedded database, file cleanup and device runtime. It starts no containers. Later registered test users are Members.

The terminal reports actual discovery and execution counts. `CORE-02` rejects a write without CSRF, checks the unchanged Lab list, then performs a valid write. `CORE-03` checks Agent access, invalid Bearer rejection without Cookie fallback, and revocation.

Without a file selection, `test:contract` runs the Core/API slice. Use `test:contract:all` for complete coverage.

Tests prepare business data through HTTP and observe results through HTTP/SSE. They return IDs and cursors unchanged. Process control provides real start, stop, and restart behavior.

## Run every required contract

```bash
pnpm test:contract:all
```

Each of the six profiles has separate data and an owned resource ledger. A failed profile fails the command.

| Profile       | Checks                                                                                         | Explicit test configuration                         |
| ------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `baseline`    | Identity, permissions, assets, world, devices, SSE, history, records, trends, and API contract | Production quotas and retention defaults            |
| `file-ttl`    | Signed upload/download expiration and authorization recovery                                   | Download 2 seconds; upload session 5 seconds        |
| `session-ttl` | Idle/absolute session expiry, SSE closure, and new login recovery                              | Idle 60 seconds; absolute 65 seconds                |
| `retention`   | Public cleanup, real gaps, unfinished tasks, last values, and expired Command receipts         | Observations 2 seconds; ended records 3 seconds     |
| `rate`        | Primary quotas 20/60/600, 429, `Retry-After`, and window recovery                              | Window 5 seconds; unchanged primary quotas          |
| `capacity`    | 1000 Entity/1000 Scene Node limits and rejected overflow                                       | Rate limiting disabled for separate capacity checks |

Baseline uses five isolated batches: Core/API, assets/world, devices, history, and SSE. Their polls cannot exhaust one shared TCP client quota. The suite has six profiles and ten real runs.

Normal rate limits remain registration 20, authentication 60, and resource 600 per 60 seconds. The 5/20/120 `fallback_limit` values and 4096 buckets remain compatibility settings. They do not replace normal quotas. The former Redis outage mode is outside the shared new-service oracle.

During development, select a focused check against a compiled target:

```bash
pnpm test:contract --no-build sse.test.ts
pnpm test:contract --no-build --profile retention
```

Use `--no-build` only after compiling the current Rust source. It cannot prove that an older binary matches the candidate.

## Read coverage and failures

The [behavior matrix](../../tests/contract/behavior-matrix.json) records sources, normal results, unchanged rejected state, recovery, tests, and budgets. `public` uses HTTP/SSE. `configuration` uses existing configuration. `internal-supplement` assigns internal rules or use-case checks to later tickets. `gap` means required coverage remains missing. A gap prevents M0 completion.

Current public interfaces cannot reliably produce deterministic 24-hour spikes, bad quality, old sources, duplicate sequence values, exact SQL counts, or exactly eight pending SSE events. The matrix assigns those checks to #48/#50. Existing SQL/Runtime fixtures do not prove HTTP coverage. Shared contracts still verify real event bytes, reconnects, and credential revocation.

Evidence is in `.scratch/vnext-m0/runs/<run-id>/`. `results.json` records discovered, passed, and failed tests. `owned-resources.json` records acquisition intent, identities, consumers, and before/after inventories. `.scratch/vnext-m0/current.json` points to the latest run. The complete command also writes a suite manifest.

Classify a failure first. Compilation, zero discovery, and fixture failures are not business red evidence. Preserve the original assertion and budget for business failures. Fixture repairs cannot change production defaults. The Rust 24-hour capacity case uses 172800 seconds of observation retention only in that case. A separate HTTP case uses the default 86400 seconds to check cropping and retention gaps. Production defaults remain unchanged.

## Compare the retained API

```bash
pnpm contracts:baseline:check
```

The [comparison tool](../../scripts/lib/contract-openapi.ts) filters only removed knowledge, notification, email password-reset, generic jobs, and system cache routes. It preserves referenced DTOs and security declarations. Declaration order does not cause drift. DTO, operationId, response status, error, and security changes report JSON paths.

Run `node scripts/contract-api-baseline.mjs --input <candidate-openapi.json>` to compare another OpenAPI file. `--write` replaces the baseline. Use it only for an approved contract change. M0 does not fix schema version 28. Rust expectations come from current build and migration sources. Other targets report their actual versions.

## Select a target and recover resources

Rust is the only built-in adapter. An executable descriptor can connect another target. This does not mean the new service exists:

```json
{ "command": "/absolute/path/to/server", "args": [] }
```

```bash
pnpm test:contract --target candidate --descriptor /absolute/path/to/target.json
```

The target receives `APP_BIND`, `APP_ORIGIN`, and a separate `CONTRACT_DATA_DIRECTORY`. It must initialize that directory and serve the same HTTP contract. Non-Rust targets do not create Docker services. Optional `version` and `schemaVersion` fields verify target metadata.

Success, failure, timeout, SIGINT, and SIGTERM stop owned consumers and clean resources. After abnormal termination, wait for the original supervisor to stop. Then run:

```bash
pnpm test:contract --recover .scratch/vnext-m0/runs/<run-id>/owned-resources.json
```

Recovery verifies process IDs, start tokens, PGID/session, and child process proofs. It then verifies container labels and immutable IDs. Unknown or replaced resources remain intact. Cleanup removes only proven resources in the owned ledger. It uses `docker rm -f -v` to remove anonymous volumes. It never runs global prune or removes existing root services and persistent volumes.

M0 Rust/Docker and process-group recovery validation covers Linux. Later foundation work owns Windows target adaptation and child-process checks. M0 does not claim a Windows pass.

Use `pnpm test:contract:lifecycle` for real interruption and wrapper descendant recovery checks. It creates its own isolated legacy stack. CI runs the complete contract on the final candidate. Local passes and a Draft PR do not replace final CI.
