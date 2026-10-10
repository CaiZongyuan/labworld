# Development And Validation

Goal: select public checks that observe your Lab Word change. Run from the repository root. The [testing strategy](strategy.md)defines responsibilities.

## Choose An Entry

| Change                         | Command                                   | Evidence and prerequisites                                                               |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Web behavior                   | `pnpm test:frontend`                      | Real component interaction; HTTP uses MSW; motion golden checks need Python 3            |
| TypeScript and boundaries      | `pnpm typecheck`, `pnpm boundaries:check` | Types, package dependencies, Node module, qualified table and SDK ownership              |
| Backend behavior               | `pnpm test:server`                        | Real Node HTTP/CLI and isolated embedded data                                            |
| Contracts                      | `pnpm generate`, `pnpm contracts:check`   | Node OpenAPI, official generated types and SDK agree                                     |
| Documentation                  | `pnpm docs:check`, `pnpm docs:build`      | Sources, locale pairing, Node references and built links                                 |
| Documentation browser journeys | `pnpm test:e2e:docs`                      | Language, theme, search, agreed viewports, custom base; requires Chromium                |
| Critical application journeys  | `pnpm test:e2e`                           | Owned Node/Web and real Chromium/WebGL; motion smoke needs the pinned Python environment |

Install Chromium with `pnpm exec playwright install chromium`. Default `pnpm test:e2e` also needs an isolated Python environment with the pinned tracked requirements. Follow [the synthetic motion setup](../tutorials/synthetic-motion.en.md#start-the-python-publisher). The runner uses `.scratch/motion-python/bin/python` by default. Set `MOTION_E2E_PYTHON` to override its executable path.

The default suite runs motion smoke. It does not run the full motion acceptance of at least 600 seconds. See [source verification](../tutorials/synthetic-motion.en.md#verify-the-source) for exact commands and coverage. `pnpm check` runs current Node, formatting, static, behavior, budget and build checks without browser E2E. Its TS/Python golden checks require Python 3; set `PYTHON` to override the interpreter. Normal Node/Web startup and builds remain Python-independent.

Command capabilities do not expand task scope. Validate desktop web by default; include mobile adaptation, narrow screens, touch or real devices only within explicitly approved scope. Check discovery and prerequisites before heavy browser runs. Reuse existing critical journeys; use focused cases for affected CSS or layout states.

`docs:check` and `docs:build` read the official Node OpenAPI and current configuration parser. `pnpm test:e2e` uses the owned Linux Node/Web browser supervisor. CI uses `pnpm check`, with complete cheap frontend/tooling checks before long server/contract suites. Keep actual browser prerequisites and task scope explicit.

## Lab Viewer Boundaries

The production Viewer and persistent World use the accepted [Lab experience](../guides/lab-viewer.md). Retained browser journeys verify real GLB/HDR/WebGL, selection, drafts, devices and recovery.

Production component checks will observe import controls, selection, loading/error and recovery. Browser checks will observe real GLB/HDR, canvas pixels, camera and resource disposal. DOM success does not prove visible 3D rendering; one memory sample does not establish a leak.

## Failure And Evidence

Record commands, missing prerequisites and unverified scope when Docker, Chromium or dependencies are unavailable. Skipped checks are not passes. Backend checks use isolated resources and do not clean development or production data.

Record evidence against a fixed revision, environment and task scope. Reuse genuine TDD red and recovery green as VDD evidence for the same assertion. Local focused checks and one full gate in the responsible environment cover the stable final candidate. Reuse included affected checks. Refresh coverage by semantic impact after repairs or main changes. The [development flow](../agents/development-flow.md) defines the sequence and independent review.

Use [development-timeline](../../.agents/skills/development-timeline/SKILL.md) for lightweight stage, wait and rework records during multi-stage collaboration. Reports explain recorded progress and uncertainty; they do not add product validation or merge gates.
