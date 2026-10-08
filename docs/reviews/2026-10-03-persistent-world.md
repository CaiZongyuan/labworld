# Persistent Lab and Entity verification

Scope: [Issue #3](https://github.com/CaiZongyuan/labworld/issues/3), based on `e6f80f5edb69c802ca46bdb296bff2fce04c38c1`. The accepted experience is Foundation v1 at `10c4c22f875b958c7adc30cf84c7a41d56a4589c`; this slice adds persistent identities and basic placement. Device execution, layout transforms, business relationships and conflict recovery remain later tickets.

## Behavior and interfaces

- Real Router/PostgreSQL checks cover Member/Agent Lab creation and querying, independent Entities and nodes, pinned definition snapshots, configuration, declaration/Binding/executability, Robot rejection, invalid references and credential rejection followed by unchanged World reads.
- Real object storage verifies that Entity/node references protect an asset and its bytes remain readable. World snapshots include every referenced asset regardless of asset catalog pagination.
- Concurrent session/World refresh first reproduced a 503. The read-only repeatable-read snapshot now follows the completed public authentication check without re-locking session rows that concurrent reads refresh; mutations retain transaction-local credential checks. The concurrent HTTP regression passes.
- Browser registration has distinct Entity identities; adding a representation creates a node while retaining the Entity. No observation is fabricated for static or disconnected physical identities.

## Simplification

The pass covered all tracked changes and task-owned new files against the base above. Shared rendering boundaries and metric sampling retain their existing behavior and the 3D lazy-loading boundary. Form commands now carry their actual typed create/register/configure payloads, capability display derives its three states from the server response, and node lookups use memoized Entity/representation indexes. Review fixes complete the generated error responses and reuse existing UI components and disabled-state conventions. No larger refactor was needed. Authorization, definition snapshots, transactional audit, reference constraints and independent model ownership remain intact.

## Validation

| Command                                                                        | Result                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node scripts/test-backend.mjs --test lab_world --test lab_assets`             | 18 initial cases passed; the added concurrent-refresh regression subsequently passed with all 4 World cases                                                        |
| `pnpm test:frontend apps/web/src/lab-world.test.tsx apps/web/src/lab.test.tsx` | 11 passed after simplification                                                                                                                                     |
| `pnpm typecheck`                                                               | Passed                                                                                                                                                             |
| `node scripts/e2e.mjs tests/e2e/lab.spec.ts`                                   | Existing asset journey passed; compressed-model journey passed after fixing registration synchronization; the new World journey passed in focused final reruns     |
| `just check`                                                                   | Passed after simplification, including full backend/frontend/tooling checks, contracts, ownership, performance budgets, application build and bilingual docs build |

E2E uses isolated PostgreSQL, Redis, object storage and actual Chromium/WebGL. The Agent tutorial script is executed against the actual API. The World journey covers canvas picking, directory identity, multiselection, compressed representations, multiple nodes per Entity, configuration, asset deletion refusal, a second Member browser, refresh, repeated Lab switching and resource counts. Resource comparisons use the same unselected scene and the first loaded-scene count as their upper bound; an empty Lab must return to its exact initial empty-scene count. This removes sampling differences from selection boxes: each selected node adds BoxGeometry and Edges geometry, and GPU upload can fall between metric samples. Desktop (1440×1000) and mobile dark English (390×844) canvas pixels were checked. The mobile Inspector was scrolled into view and inspected for UUID wrapping and usable controls.

A separate short browser regression forces the WebGL2 capability to be absent and checks that the recovery alert is below the canvas tools. It first failed with alert top 356px versus toolbar bottom 408px; both render fallbacks now share the bottom alert placement. This failure-state injection does not replace the real WebGL journey.

The three-column structure matches the accepted experience at comparable desktop dimensions. Narrow screens stack the directory, canvas and Inspector in the work area's scroll surface; no horizontal overflow or incoherent text overlap was observed. Evidence is generated at `test-results/lab-foundation/t02-world-desktop.png`, `t02-world-mobile-dark-en.png` and `t02-inspector-mobile-dark-en.png`. Existing Draco/Meshopt/Basis screenshots retain their t01 paths. Rendering figures use software rendering and are diagnostic counts, not hardware performance thresholds or GPU-byte measurements.

The bilingual [tutorial](../tutorials/persistent-world.md), [English tutorial](../tutorials/persistent-world.en.md), executable [Agent requests](../../examples/lab/register-world.mjs), generated OpenAPI/SDK and [ownership manifest](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/module.json) are delivered with the behavior. The PR records the final reviewed revision and CI checks.
