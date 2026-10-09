# Operate devices through the same Entity detail

Goal: select an Entity in the 3D space. Separate targets, actual observations, Commands and Task results. Recover a failed source restart.

## Starting state and source

Complete [Spatial workbench](spatial-workbench.md) first. Use the current checkout containing this chapter. Prepare a persistent Lab, two simulated lights and two simulated centrifuges. A Member needs a valid session. An Agent uses the same public interfaces with a valid `lab:full` key.

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/lab>. The 3D space opens first after login. Start, Stop and actions below write to the development database.

The [shared detail](../../packages/views/src/lab/entity-detail.tsx) provides Operations, Records and Details. The [workbench context](../../packages/views/src/lab/workbench-context.tsx) retains targets and attempts per deployment, identity, Lab and Entity. The [property reader](../../packages/views/src/lab/observation-state.ts) reads server facts. It does not infer actual values from heartbeats. Devices use the existing [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts). This chapter adds no API.

## Separate targets from actual values in Operations

1. Open the object directory.
2. Select `Light A`.

   The detail header shows its name, registered location, simulated source and identity type. **Operations** shows actual values, units, quality and times. A property without a report shows **Unknown · No observation**.

3. Select **Start program**.
4. Wait for the first observation.
5. Set **Target brightness (%)** to `23`.
6. Select **Apply**.

   The Command shows submission, waiting and execution outcome. Reported brightness changes only when the server reports that property. Neither accepted nor succeeded replaces an actual observation.

7. Select `Light B`.
8. Set its target brightness to `77`.
9. Return to `Light A`.

   A retains its target of `23`. B retains its own inputs and Command feedback. Selection changes do not turn targets into measurements. **Requested power target** retains the last request separately from **Reported power**.

Targets and attempts remain in the current workbench session. Reloading reads persistent actual state. These inputs are not backend device configuration.

## Check current and last reported values

A property shows **Current observation** only when all these conditions hold:

- Its value matches the fixed definition type. `false` and `0` are valid. `null` and missing values remain unknown.
- Property freshness is `current`, source time is known, and quality is `good`.
- The property belongs to the current Binding and the current running Run.

1. Stop the program on `Light A`.

   Reported values remain as **Last reported value**. Their original source and time remain. Stop does not switch the light off.

2. Start the program again.

   The View shows a new Run. Properties without reports from that Run retain their last values. A brightness report cannot refresh the old power property. Neither can a heartbeat.

3. Open **Details**.

   Check each property's Binding, Run, sequence, source time, receive time, update time, expiry, quality and original freshness. Current execution identities remain separate from each property's original identities.

4. Open **Records**.

   Filter existing history for the same Entity. A history query does not change device state. See [Run history](run-history.md) for retention and public queries.

## Recover sources and uncertain Commands

1. Select **Restart source** on a running device without an active Task.
2. Confirm the restart.

   The View requests Stop first. It requests Start only after Stop succeeds. A failed Stop prevents Start. If Stop succeeds and Start fails, the source stays stopped. Select **Start program** to recover. A new Run does not resume an old Task or replay old actions.

A lost response shows **Submission uncertain**. Retain the original parameters and key. Select **Retry same command**. For a known Command, select **Refresh command** to query its record. Do not automatically repeat actions with a new key. An old Run's action cannot replay in a new Run.

A connection failure or unavailable service retains the last snapshot and disables new operations. Reconnect, then confirm server state. Log in again after identity expiry or revocation. An old identity's attempts cannot be used by a new identity.

## Complete and cancel centrifuge Tasks

1. Select `Centrifuge A`.
2. Start its program.
3. Set target speed to `6000 rpm`, target temperature to `22 degC`, and Task duration to `6 s`.
4. Select **Start centrifuge**.

   The backend fixes Task parameters. Preparation does not count toward effective Task time. The backend starts timing after reaching tolerance. The Task then decelerates.

5. Wait for **Completed**.

   The device returns to idle. The completed result remains visible. A new Run or later idle observation cannot replace an ended result.

6. Start a `60 s` Task on `Centrifuge B`.
7. Select **Stop centrifuge**.
8. Wait for deceleration to finish.

   B's result becomes cancelled. A retains independent targets and results. **Stop centrifuge** cancels a Task. **Stop program** ends a Run. Cancel an active Task and wait for idle before stopping its source. See [Centrifuge Tasks](centrifuge-tasks.md) for ranges, backend stages and interruption recovery.

## Verify and continue

```bash
pnpm exec vitest run apps/web/src/lab-device-details.test.tsx apps/web/src/lab-devices.test.tsx apps/web/src/lab-centrifuges.test.tsx
```

This entry operates actual Lab Views. MSW replaces HTTP only. Actual Node/Web browser acceptance uses separate services and persistent data. It checks desktop and approved narrow screens, actual WebGL pixels, focus and action targets. Tests do not use your active development database.

Continue with [Device trends](device-trends.md). Read the same device’s historical values, gaps and sources.
