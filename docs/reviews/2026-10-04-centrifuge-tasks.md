# Centrifuge Task Validation

Scope: [Issue #7](https://github.com/CaiZongyuan/labworld/issues/7), [spec #1](https://github.com/CaiZongyuan/labworld/issues/1), ADR 0006–0008 and accepted preview `10c4c22f875b958c7adc30cf84c7a41d56a4589c`.

Base: `ddaf175ca2158c3cd0c6d2ad8d29ecae7ea561d3`. Branch: `feat/7-centrifuge-tasks`. Worktree: `.worktrees/7-centrifuge-tasks`. The PR records the final immutable review tree and pushed head. Root user documentation changes are outside this ticket.

## Behavior And Public Tests

Start acceptance reserves a DeviceTask and an independent result identity. The Command, Run, Task and result each have authenticated queries. Task parameters remain fixed. A second Start receives busy. Same-key, same-parameter retries return the same identities. Different parameters conflict.

The backend samples each centrifuge at 1Hz. RPM and temperature must reach tolerance before timing starts. Preparation and deceleration do not count. Stop preserves counted time between samples and produces cancelled after zero RPM. Stop during normal deceleration still cancels. Fault and uncertain reports fix failed or unknown outcomes. They cannot later become completed. Program stop is rejected until the active task ends.

Nine public HTTP/runtime tests cover acceptance, fixed parameters, identities, retries, busy rejection, tolerance, timing, Stop, independent instances, fault, uncertain execution and generation fencing. Tests use a real Router, isolated PostgreSQL and `ObservationClock`. Reads use HTTP. Reports use the existing trusted device ingress. Record queries reject malformed Lab and Entity identities before reaching storage.

Observed red states included a 422 Start rejection, unchanged zero RPM during preparation, fault reports leaving a task running, lost time between samples, missing centrifuge inputs and a busy error without a reason. The corresponding public behavior checks are green. Existing lighting, sensor and subscription checks also pass.

## Validation

- `node scripts/test-backend.mjs --test lab_centrifuges --test lab_devices --test lab_sensors --test lab_sync` covers the changed device boundary and existing consumers.
- `pnpm exec vitest run apps/web/src/lab-centrifuges.test.tsx apps/web/src/lab-devices.test.tsx` passes. MSW replaces only HTTP. The new checks cover typed submission, Stop while acceptance is pending and actionable busy recovery.
- `just check` passes tooling, Rust, frontend, formatting, static, contract, ownership, budget, application, desktop and documentation checks. The final PR records exact totals. The initial application payload is 229.6 KiB gzip; budgets are unchanged.
- Paired tutorial navigation, links and snippets pass `pnpm docs:check` and `pnpm docs:build`.

## Real Backend And Browser

`node scripts/e2e.mjs tests/e2e/lab-centrifuges.spec.ts` passes against isolated services and random API, Worker and Web ports. The Member operates two built-in centrifuges. An independent Agent reads the same tasks and runs the complete tutorial example. The browser checks actual canvas pixels, moving RPM-driven rotors, independent idle state, completion and cancellation.

The journey closes all browser contexts while a task is active. The backend completes that task and retains its result. A reopened browser reads the same identities.

The journey then kills the isolated API process with SIGKILL. The test supervisor starts a new API process and publishes a different PID. The old Run, unfinished Task and result become interrupted. Their identities, frozen parameters and last observation values and reception time remain. A Member explicitly starts a new Run. It reports idle. Older completed, cancelled and interrupted records remain queryable. The public ingress test separately rejects the retired Run's late report.

The first browser attempts exposed test assumptions: an existing SSE connection can take its ten-second idle deadline to detect restart, and the shell offers English directly. The final journey allows the complete connection recovery period and uses that real button. No test-only business route is added.

Desktop Chinese/light and 320px English/dark checks compare the actual workspace with the accepted preview. Screenshots remain in `test-results/lab-foundation/t06-centrifuge-*.png`. A separate mobile canvas capture verifies the scene. Text and controls fit without horizontal overflow. The Inspector separates current form values from the old interrupted task's frozen parameters. The product has no preview time multiplier or scenario toolbar.

The built-in definition declares the rotor node, local Y axis and observed speed mapping. Each instance owns its rotor and changing material. Imported GLB appearances remain static. The browser calculates animation frames from observed RPM. These checks use software WebGL and do not establish target-hardware performance. History, archiving, replacement and large-scene validation remain later tickets.

## Simplification And Documentation

The repository reduce-complexity pass covers every changed and new ticket file against the fixed base. It shares initial-temperature lookup and tolerance rules. It retains independent Command, Run, Task and result records. Review of the same boundary also found ignored observation rejection values; the uncertain-execution regression covers their correction. Larger consolidation of the separate API and Worker test supervisors is deferred because their shutdown lifecycles have separate owners.

Independent Spec review found that repeated Stop requests reset the deceleration reference. Stop, fault and uncertain paths now preserve that reference once slowing begins. The public clock regression checks repeated Stops and a fault during deceleration. Stop reports only changed phase and timer properties. It preserves RPM and temperature measurement times until the next sample. Independent Standards review found recovery instructions with multiple actions. Both tutorials now use numbered steps with one action each. The refreshed reviews cover these corrections.

Lab ownership includes the task/result tables, migration, public contract symbols, tests, paired chapter and runnable Agent example. Earlier migrations keep their checksums. `centrifuge-tasks` follows `continuous-temperature`. Product scope and the previous chapter now describe delivered centrifuge behavior and the remaining scope.

A manual language review compares every changed public passage with the root working tree's current documentation rules. It checks short active sentences, one action per step, units, limits, conditions, failure recovery and Chinese/English parity. Structural checks do not establish full ASD-STE100 compliance.

Independent Standards and Spec reviews must cover the complete immutable ticket tree before commit. Their findings, corrections and final coverage are recorded in the linked PR. Required CI must cover the final pushed head before integration.
