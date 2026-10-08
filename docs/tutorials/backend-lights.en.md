# Control Backend Lighting Programs

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: start two independent lights, invoke the same commands as a Member and an Agent, and distinguish command results from observations with an identified source.

## Starting Revision and Changes

Use the current checkout containing this chapter's Node implementation. Complete [Node World](../guides/server-world.en.md) first. You need a Lab, Entities, separate nodes, pinned definitions and a `lab:full` credential. Run commands from the repository root. Browser operations and the script write development data.

Entry points are [device HTTP](../../packages/server/src/lab/devices/use-cases.ts), the [public device runtime and observation interface](../../packages/server/src/lab/devices/runtime.ts), [migration](../../packages/server/migrations/0000_baseline.sql), [source-order migration](../../packages/server/migrations/0000_baseline.sql), [Inspector](../../packages/views/src/lab/device-panel.tsx), [3D appearance](../../packages/views/src/lab/world-viewport.tsx) and [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts). [Lab ownership](../../packages/server/src/lab/ownership.json) registers the new tables, contracts, tests and tutorials.

## Get the First Browser Observation

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/lab>, sign in as a Member and create `Lighting lab`. Register `Light A` and `Light B` using `Smart light · 1.0`, built-in appearance and simulated identity.

1. Select A. Without a report, it shows **Unknown · No observation**. Its Binding implements lighting, but the program is not started and actions are not executable.
2. Click **Start program**. Open **Details** and record the current Run UUID. Return to **Operations**. Starting does not invent an observation. Toggle **Power**: submission and waiting appear before execution completes and the actual observation arrives. The shade emits light from the server report.
3. Enter `35` in **Target brightness (%)** and click **Apply**. This input is separate from **Reported brightness**, which becomes `35 percent` only after the device reports it.
4. Start B and turn on its power. Its Run, Binding, source and observation are independent; dimming A does not change B.
5. Close and reopen the page. Programs run on the backend and observations remain readable. Click A's **Stop program**: the last values and source time remain, with **Source stopped** freshness. Stopping a program does not turn off the light.

Only the built-in backend `light.v1` program executes; user code is not supported. A Run snapshots instance configuration at startup; later configuration edits apply on the next start. Migration gives previously registered simulated lights a Binding without rewriting their pinned definitions. Entity capabilities obtain execution metadata from the Binding and separately report definition support, implementation and current executability. Physical identities still have no execution Binding.

## Independent Agent Commands and Retries

Obtain an active `lab:full` API key in settings. The script creates a Lab and two lights; set `LAB_ID` to reuse an existing Lab.

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
# Optional: export LAB_ID=<lab-uuid>
node examples/lab/control-lights.mjs
```

Output contains distinct Entity/Run UUIDs, a command UUID and two reported states: A has `on=true, brightness=35`, B has `on=true, brightness=20`. A retains its values after stopping; B continues running. Open the printed Lab in the browser to inspect the same state and actual pixels.

Complete executable requests:

<<< ../../examples/lab/control-lights.mjs

`POST /api/v1/lab/labs/{lab_id}/entities/{entity_id}/actions` requires `Idempotency-Key`. Send `{ "capability": "light.set_power", "parameters": { "on": true } }` and receive a 202 command record. `light.set_brightness` accepts numeric `brightness` from 0–100, in percent. Capability version is `1.0`; `applied_by_device_program` means the program applied the action. Acceptance alone is not a measurement.

`GET .../commands/{command_id}` returns `accepted`, `executing`, `succeeded`, `failed` or `unknown`, plus actor, parameters and result. The same actor, Entity, key and equivalent JSON parameters return the same command; different parameters produce 409. Members and Agents share the records. A user's session and Agent credentials share the same key namespace.

`GET .../entities/{entity_id}` and World snapshots return the Binding, current Run, observation and three capability layers. Observations include `source`, `run_id`, `sequence`, `observed_at`, `received_at`, `updated_at`, `quality` and `freshness`. Absent source time remains `observed_at=null` with `source_time_unknown`. Receipt time does not replace it. Lights report when state changes. `current` identifies a report from a still-running source. See [continuous temperature](continuous-temperature.en.md) for implemented sampling and expiry. The page receives snapshots and property changes through [reliable subscriptions](reliable-sync.en.md). Command polling stops after 30 seconds. Operations require persistent capability permission and immediate service readiness from `X-Lab-Runtime` / `runtime_status`.

## Failure and Recovery

The script verifies that `brightness=101` produces `422 lab.invalid_parameters` and a new action after stopping produces `422 lab.program_not_running`, without changing observations. Unimplemented Robot actions return `422 lab.capability_not_implemented`. Member and Agent rejections agree. Session writes require CSRF; invalid, expired or revoked Agent credentials cannot write.

Without an active Task, **Restart source** requests Stop before Start. A failed Stop prevents Start. If Start fails after Stop, select **Start program** explicitly. Old actions do not replay and old Tasks do not resume. See [Operate and trace devices](device-details.md) for the ordinary UI.

After a lost response, the page shows **Submission uncertain** and retains the parameters and key, including after selecting another Entity and returning. **Retry same command** reuses that key; **Refresh command** queries a known command. Do not automatically repeat unknown execution using a new key. Backend restart marks former Runs `interrupted` and unfinished commands `unknown`, keeps the last observation and requires explicitly starting a new Run. Reports from old Runs or runtime hosts are rejected. After server code changes, stop and rerun `pnpm dev` with the same recovery rule.

Node acquires its directory lease, migrates and recovers before HTTP admission. Startup failure prevents new actions. After recovery, query or retry uncertain requests with the original key.

## Verification and Next Stage

```bash
pnpm test:server
pnpm exec vitest run apps/web/src/lab-devices.test.tsx apps/web/src/lab-device-details.test.tsx
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-node-assets-world.spec.ts
```

HTTP contracts use the real Hono Router and an isolated embedded PGlite database to check device commands and restart. Component tests replace only HTTP with MSW. The listed Node browser entrypoint checks Asset, World, layout and WebGL; this chapter's script checks independent Agent device operations. The complete Node client journey will be validated during the later client migration. The [historical Foundation journey](complete-foundation.en.md) preserves its old revision and load reference; it does not select this chapter's starting revision. Continue with [continuous temperature](continuous-temperature.en.md). Layout versions remain separate from runtime observations.
