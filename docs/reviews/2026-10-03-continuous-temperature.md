# Continuous Temperature Validation

Scope: [Issue #6](https://github.com/CaiZongyuan/labworld/issues/6), approved [spec #1](https://github.com/CaiZongyuan/labworld/issues/1), ADR 0006–0008 and accepted Foundation preview `10c4c22f875b958c7adc30cf84c7a41d56a4589c`.

Original base: `cbf2883246cd2a1dcfff1c8801f3e90b468b4f63`. Integration/review base: `fece778cddb1db85f432c0c64672617a447317be`. The intervening Core cache test maintenance is upstream work, not part of this ticket. Branch: `feat/6-continuous-sensors`; isolated worktree: `.worktrees/6-continuous-sensors`.

## Behavior And TDD

Backend sensors have independent Bindings, frozen Run configuration and 1Hz sampling. Trusted `ObservationSink` owns measurement validation and writes. Member and Agent HTTP operations cannot overwrite measurements. Each property retains its value, unit, Binding, Run, source, sequence, source time, reception time, update time, quality and report deadline.

Properties merge independently. Source time ordering uses a per-property watermark. Missing source times remain null and preserve the watermark. Heartbeats and repeated sequences do not refresh old measurements. Stopped and interrupted Runs retain their last values; new Runs require new reports. Binding mismatches and retired Runs cannot regress current facts.

The five-second deadline measures recent reception. Actual measurement age still requires inspecting `observed_at`. The API persists expiry and advances `world.version`. Time alone cannot silently change a versioned snapshot. Layout versions and drafts remain independent. Existing capability permission and immediate runtime availability remain separate.

Observed red states: missing backend sampling interface; rejection of partial reports; missing controlled clock/ingress interface; missing Inspector temperature; a Chinese accessible-name query after switching to English. The corresponding public behavior checks are green. Retirement and direct-write refusal reuse established behavior and passed their added regression checks.

## Checks

- `node scripts/test-backend.mjs --test lab_sensors --test lab_devices --test lab_sync`: five sensor, nine lighting and eight subscription tests pass. Controlled time also distinguishes expired and current properties within the same Entity.
- `pnpm test:frontend apps/web/src/lab-sensors.test.tsx apps/web/src/lab-devices.test.tsx`: five pass. MSW replaces only HTTP. The sensor journey covers unknown, current, expired, recovered, absent source time, quality, read-only controls and language switching.
- `just check`: 64 tooling tests, 211 Rust tests and 271 frontend passes with four existing skips. Formatting, static checks, contracts, ownership, query/bundle budgets, application/desktop and bilingual documentation builds pass. Final initial gzip is 228.7 KiB; existing budgets remain unchanged.
- Documentation-only follow-up changes receive refreshed `docs:check`, `docs:build` and formatting checks. Viewport refinements receive a final full check before publication. The PR records final immutable head/tree coverage.

## Real Application

`node scripts/e2e.mjs tests/e2e/lab-sensors.spec.ts` passes against the real API, Member, independent Agent, database, browser and WebGL. Sampling continues after the only page closes. Stopping retains values and reception time through expiry. Both identities read the same retained observation. Restarting produces a new Run and current report. The runnable Agent tutorial performs the same stop, expiry, rejection and recovery journey.

Desktop Chinese/light and 320px English/dark checks include screenshots, nonblank canvas pixels and no horizontal overflow. The selected Scene Node carries the readout. Other instances remain independently queryable. Selection and bounded readout placement prevent label collisions on narrow scenes. Source timestamps and quality are available in the readout's hover text and Inspector.

The first browser run failed because its locator retained the Chinese Inspector name after an English switch. A small component loop reproduced the accessible-name mismatch. Correcting the query made the full journey pass. Screenshot inspection then found overlapping labels with four sensors; selected-node display and bounded placement fixed this. The refreshed real journey passes. No backend behavior change was needed for those browser findings.

Independent Spec review found a missing readout when a sensor used an imported GLB appearance. The real Draco GLB sensor regression went red. Moving the readout to the shared Scene Node layer made the complete journey pass. It now checks both imported and built-in appearances, including narrow-screen bounds. Existing measured geometry bounds position the readout independently of appearance.

Screenshots remain local artifacts under `test-results/lab-foundation/t05-temperature-*.png`. They were compared with the accepted preview's desktop and narrow-screen workspace. No target-hardware performance claim is made. Large-scene capacity and the full draft/network combination remain Issue #11 responsibilities.

## Simplification And Documentation

The repository reduce-complexity pass covers all changed and new task files against the integration base. It shares current source validation, uses typed property maps instead of dynamic JSON parsing, removes obsolete Run-wide watermark updates and shares observation value formatting. Migration backfill preserves the old last-known source time. Existing migrations keep their checksums. The selected readout refinement is included in the refreshed pass.

Lab ownership declares the new migration, contract type, tests, paired tutorial and Agent example. The chapter `continuous-temperature` follows `reliable-sync`. Product and Viewer documentation describe delivered sensors. Removal tooling is not claimed.

A separate language review compares changed public prose against the root working tree's updated documentation rules and ASD-STE100-inspired author guide. It checks short sentences, explicit actors, one action per step, units, limits, permissions, source-time meaning and bilingual parity. Documentation structure checks do not replace this language review. Independent Standards review receives the same root rule files.

Independent Standards and Spec review must cover the complete immutable task tree before commit. Their final coverage and results are recorded in the linked PR. Required CI must cover the final pushed head before integration.
