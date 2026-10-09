# Use Shared Device Details

Goal: operate two lights and two centrifuges in one persistent Lab. Check requested targets, Commands, observations, program runs and task results separately.

## Starting State And Complete Change

Complete the [spatial workbench](spatial-workbench.md) chapter. Use this chapter's source and keep the existing Lab. Members need an active session. Registration, start, action and stop operations write persistent development data.

[EntityDetail](../../packages/views/src/lab/entity-detail.tsx) combines Operations, Records and Details. Normal [device controls](../../packages/views/src/lab/device-panel.tsx) and [centrifuge tasks](../../packages/views/src/lab/centrifuge-panel.tsx) use the existing generated SDK. The [workbench context](../../packages/views/src/lab/workbench-context.tsx) keeps inputs, command attempts and source operations per identity, Lab and Entity. It still owns one World query and subscription.

This chapter adds no Lab API, runtime engine or permission role. The Universal App Shell and SaaS Core do not read device concepts.

Run from the repository root:

```bash
pnpm install --frozen-lockfile
just dev
```

Open <http://127.0.0.1:5173/lab>. Space is the default view. Select an existing Lab. Register simulated `Light A` and `Light B` with `light@1.0`. Register `Centrifuge A` and `Centrifuge B` with `centrifuge@1.0`.

## First Actual Feedback

1. Select A through the directory or scene. Its name, registered location and simulated identity are visible. Missing properties show **Unknown · No observation**.
2. Open **Operations** and select **Start program**. Confirm the running state. Lighting reports its actual properties after the next action; Start success alone does not create observations.
3. Toggle **Power**. Check **Requested power target** and Command feedback. The power control and reported power change only with reports.
4. Enter `35` in **Target brightness (%)** and select **Apply**. Wait for reported brightness `35 %`.
5. Select B, start it and set another brightness. Return to A. Its input, attempt, Run and report remain independent.
6. Open **Details**. Inspect Entity, definition, Binding, Run and each property's provenance. Original ISO timestamps retain server precision.

Current Binding and Run identities appear independently. A light's new Run is queryable before its first report. After restart, an old report's Run remains distinct from the current Run. Task, its Run, Command and result identities come from their actual records; an old result does not become a new Run's task.

On phones, the selected object's scene and bottom details remain visible together. Operations retains actual values, units, quality and freshness; Details retains full property sources and timestamps. Centrifuge Start/Stop stays outside the scrolling parameters.

Actual values can differ from targets. `accepted` means the Command is recorded. `executing` means execution is in progress. `succeeded` is an execution outcome. None replaces a device report.

## Current And Last Reports

Lab owns the shared [observation reading module](../../packages/views/src/lab/observation-state.ts):

<<< ../../packages/views/src/lab/observation-state.ts

A sensor requires temperature. Lighting requires power and brightness. A centrifuge requires speed and temperature. All required properties must meet these conditions.

| Condition            | Field to inspect                                   |
| -------------------- | -------------------------------------------------- |
| A typed actual value | Property `value`; zero and false are valid         |
| Current freshness    | Property `freshness=current`                       |
| Known source time    | Non-null property `observed_at`                    |
| Good quality         | Property `quality=good`                            |
| Current source       | Property `binding_id` matches the current Binding  |
| Current running Run  | Property `run_id` matches; Run status is `running` |

Disconnection also produces a read-only last snapshot. Missing values stay unknown. Stopped sources and previous Bindings or Runs retain their value, time and source as last reports. Starting a Run cannot refresh them. Heartbeats and other properties cannot refresh their timestamps.

Registered location uses actual `located_in` and `contains` relationships. Placement or camera changes cannot prove a physical move. Unbound physical objects keep their identity. Declaration, implementation and current executability remain separate.

## Tasks And Results

1. Select A and start its program. Starting a Run does not create a Task.
2. Enter speed, temperature and duration. The actual Capability supplies allowed ranges. Select **Start centrifuge**.
3. Observe preparation. Counted time starts only after speed and temperature reach their targets. The backend Task supplies this time.
4. Submit different parameters on B. Return to A. Active controls display that Task's fixed parameters.
5. Select **Stop centrifuge** on B. Confirm, wait for zero speed, then check `cancelled`.
6. Let A finish normally and check `completed`. Reported device `idle` and the result remain separate.
7. Close and reopen the Lab. Backend tasks continue. Results remain available within retention.

Task stop and Run stop are separate operations. An active Task prevents program stop. A succeeded stop Command does not mean deceleration has finished.

## Source Recovery And Uncertain Attempts

Use **Restart program** when a running source lacks valid observations. Confirm to Stop before Start. Failed Stop prevents Start. If Start fails after Stop, the stopped fact remains visible. Select **Start program** explicitly to recover.

A new Run does not resume the old Task or clear its result. Submit a new Task separately. Old properties retain their old Run and timestamp until a new report arrives.

Correct rejected parameters or busy state without changing reports. Retry transmission uncertainty with **Retry same command**, preserving the original key. Use **Refresh command** for a known Command id. `unknown` never triggers an automatic new-key action in the same Run.

Disconnection keeps inputs, attempts and the last synchronization time while disabling new device operations. Reconnect obtains the latest World. Ended credentials use normal login recovery and clear protected caches. Old actions are not replayed.

## Records, Verification And Next Chapter

**Records** uses existing per-device history. Device, type, time, pagination and retention gaps remain available. Select raw Observation to inspect reports. Failed loading keeps existing records and provides retry. Other chapters add Lab-wide records and trends.

```bash
pnpm typecheck
pnpm exec vitest run apps/web/src/lab-device-details.test.tsx apps/web/src/lab-devices.test.tsx apps/web/src/lab-centrifuges.test.tsx apps/web/src/lab-sensors.test.tsx apps/web/src/lab-sync.test.tsx
node scripts/e2e.mjs tests/e2e/lab-device-details.spec.ts
```

Views uses MSW only for HTTP. Browser checks use isolated real identity, API, PostgreSQL, Worker, RustFS and WebGL. They check backend continuation, independent devices, representative viewports and actual canvas pixels. Never target existing development or production data.

Continue with [backend lighting control](backend-lights.md) for Member and active `lab:full` Agent requests and recovery.
