# Backend Lighting Verification

Scope: [Issue #4](https://github.com/CaiZongyuan/labworld/issues/4), based on `a4354a6936c10c0426b959ffa8f3debbc5afa68a`. The accepted experience is Foundation v1 at `10c4c22f875b958c7adc30cf84c7a41d56a4589c`. This slice delivers backend lighting; reliable push, continuous sampling, centrifuge tasks and history retention remain their published tickets.

## Behavior and Recovery

Real Router/PostgreSQL tests cover independent Binding and Run identities, separate accepted commands and actual observations, Member/Agent parity, typed/versioned capabilities, rejection followed by unchanged observations, concurrent durable idempotency, equivalent numeric JSON parameters and conflicts. Configuration snapshots belong to each Run; commands and reports do not change layout versions. A persisted pre-execution definition fixture verifies that Binding execution metadata is available while the Entity's pinned definition remains unchanged through startup.

The public device runtime/observation interface verifies null source timestamps, receipt/update timestamps, duplicate and delayed report rejection, stopped-source retention, restart interruption, unknown command results, explicit startup and fencing of both old Runs and old runtime hosts. The backend queue marks execution before applying it and never reclaims uncertain execution.

Review identified a mixed-time ordering edge: a known timestamp followed by an unknown one erased the chronology check. A public observation regression reproduced the subsequent older timestamp being accepted. Each Run now retains its last known source-time watermark independently of the current report; an unknown report stays unknown and later older reports leave it unchanged. Migration 0021 backfills existing known reports without changing prior migration checksums or observations. Reading the watermark with the already-locked Run also removes a separate current-observation timestamp query.

The full backend suite exposed an API startup regression on an unmigrated database. The fixed host serves the existing unavailable readiness contract and initializes the Lab runtime in its own loop. A production runtime gate rejects program startup and new commands before initialization. Public HTTP recovery tests reuse the rejected key successfully after initialization and confirm repeated empty-queue processing does not interrupt an established Run. Initialization retries only while the host has no runtime; ordinary execution errors do not initialize again.

Component tests use user-event and replace only HTTP with MSW. They cover submission, waiting, measured-state isolation, rejection, response loss with the same key across selection, and explicit startup after an interrupted command without an automatic resubmission.

## Simplification

The repository-owned pass covers the entire task diff and task-owned new files from the base above. Immutable built-in definitions are parsed once, and Entity capability projection borrows the installed program contract instead of reparsing/cloning the catalog per Entity. Observation writing and ordering remain centralized, including the mixed-time watermark fix. The host loop lives in Lab; the application only composes it, its availability and shutdown. UI commands retain their original attempt across selection, show business outcomes rather than internal result JSON, and derive control availability from server capabilities. No larger refactor was required.

Authentication/CSRF, transaction-local credential checks, independent configurations/materials, durable command identity, unknown-result protection, run-generation fencing and frozen definitions are retained. The pass was refreshed after the readiness compatibility fix.

## Validation

- `node scripts/test-backend.mjs --test lab_devices --test lab_world --test migration`: 8 device, 4 World and 2 migration cases passed after the watermark fix; the full suite also covers the host composition.
- `pnpm test:frontend apps/web/src/lab-devices.test.tsx apps/web/src/lab-world.test.tsx apps/web/src/lab.test.tsx`: the affected 15 cases are covered by the passing full suite; the 4 device component cases also passed separately.
- `just check`: passed after the watermark fix with 193 Rust, 262 frontend and 63 tooling cases, plus 4 existing frontend skips. Format, Clippy, static/type checks, contracts, ownership, deterministic budgets and app/bilingual-docs builds passed. Initial payload was 226.1 KiB gzip; 23 asynchronous chunks stayed within the existing budget.
- `node scripts/e2e.mjs tests/e2e/lab-devices.spec.ts`: final real-stack journey passed after the gate, including independent pixel regions, Agent execution after all pages closed, source stopping, the executable tutorial, updated desktop command area and actual English/dark/mobile evidence. No page errors or horizontal overflow were observed.

The browser uses isolated PostgreSQL, Redis and object storage with actual Chromium/WebGL. It compares before/after canvas pixels for each light and requires their changed regions not to overlap. Closing every page removes the client runtime before an independent Agent dims B; reopening reads the completed backend observation. Restart/source ordering use the public runtime interface; this slice does not claim an additional OS-process restart browser test.

The three-column work area follows the accepted experience. Desktop evidence is `test-results/lab-foundation/t03-lights-desktop.png`. Final narrow English/dark evidence uses `t03-lights-mobile-dark-en.png` and `t03-inspector-mobile-dark-en.png`; mobile canvas pixels must be nonblank and the page must have no horizontal overflow. Rendering uses SwiftShader and does not establish a target-hardware performance threshold.

The bilingual [tutorial](../tutorials/backend-lights.md), [English chapter](../tutorials/backend-lights.en.md), executable [Agent requests](../../examples/lab/control-lights.mjs), generated OpenAPI/SDK and [ownership manifest](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/module.json) are delivered together. The PR records independent Standards/Spec reports, reviewed tree, final head and CI checks.
