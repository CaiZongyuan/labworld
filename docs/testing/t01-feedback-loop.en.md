# Development And Validation

Goal: select public checks that observe your Lab Word change. Run from the repository root. The [testing strategy](strategy.md)defines responsibilities.

## Choose An Entry

| Change                         | Command                                   | Evidence and prerequisites                                                    |
| ------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| Web behavior                   | `pnpm test:frontend`                      | Real component interaction; HTTP uses MSW                                     |
| TypeScript and boundaries      | `pnpm typecheck`, `pnpm boundaries:check` | Types, package dependencies, Node module boundaries and frozen Rust ownership |
| Backend behavior               | `pnpm test:server`                        | Real Node HTTP/CLI and isolated embedded data                                 |
| Contracts                      | `pnpm generate`, `pnpm contracts:check`   | Node OpenAPI, official generated types and SDK agree                          |
| Documentation                  | `pnpm docs:check`, `pnpm docs:build`      | Sources, locale pairing, Node references and built links                      |
| Documentation browser journeys | `just e2e-docs`                           | Language, theme, search, agreed viewports, custom base; requires Chromium     |
| Critical application journeys  | `pnpm test:e2e`                           | Owned Node/Web and real Chromium/WebGL                                        |

Install browser prerequisites with `pnpm exec playwright install chromium`. `just check` runs main formatting, static, behavior, budget and build checks without browser E2E. `just check-full` adds application E2E.

Command capabilities do not expand task scope. Validate desktop web by default; include mobile adaptation, narrow screens, touch or real devices only within explicitly approved scope. Check discovery and prerequisites before heavy browser runs. Reuse existing critical journeys; use focused cases for affected CSS or layout states.

`docs:check` and `docs:build` read the official Node OpenAPI and current configuration parser. `pnpm test:e2e` uses the owned Linux Node/Web browser supervisor. The current CI uses `pnpm check:m1`; final cleanup will update frozen `just check` aliases. Keep actual browser prerequisites and task scope explicit.

## Lab Viewer Boundaries

The production Viewer and persistent World use the accepted [Lab experience](../guides/lab-viewer.md). Retained browser journeys verify real GLB/HDR/WebGL, selection, drafts, devices and recovery.

Production component checks will observe import controls, selection, loading/error and recovery. Browser checks will observe real GLB/HDR, canvas pixels, camera and resource disposal. DOM success does not prove visible 3D rendering; one memory sample does not establish a leak.

## Failure And Evidence

Record commands, missing prerequisites and unverified scope when Docker, Chromium or dependencies are unavailable. Skipped checks are not passes. Backend checks use isolated resources and do not clean development or production data.

Record evidence against a fixed revision, environment and task scope. Reuse genuine TDD red and recovery green as VDD evidence for the same assertion. Local focused checks and one full gate in the responsible environment cover the stable final candidate. Reuse included affected checks. Refresh coverage by semantic impact after repairs or main changes. The [development flow](../agents/development-flow.md) defines the sequence and independent review.

Use [development-timeline](../../.agents/skills/development-timeline/SKILL.md) for lightweight stage, wait and rework records during multi-stage collaboration. Reports explain recorded progress and uncertainty; they do not add product validation or merge gates.
