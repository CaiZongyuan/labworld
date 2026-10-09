# Layout and Relationship Verification

Scope: [Issue #5](https://github.com/CaiZongyuan/labworld/issues/5), based on `b707bc93ccfa5b03c00acc2cd2fc29069f03b1b1`. The accepted Foundation v1 experience remains `10c4c22f875b958c7adc30cf84c7a41d56a4589c`. Persistent identity and backend lighting are the integrated starting point. Reliable push, additional programs, lifecycle operations and retained history remain their published tickets.

## Behavior and Recovery

Layout saves compare `expected_version` under a Lab row lock and atomically validate and replace nodes and explicitly submitted relationships. Node identity cannot be reassigned to another Entity while it exists, and foreign Lab references, missing representations, duplicate ids and invalid Placement ranges are rejected before commit. Omitting relationships preserves them; an explicit array replaces them. A stale save returns `409 lab.layout_conflict`, and concurrent writers accept only one version. Failure and unauthorized-request tests continue by reading the unchanged World through HTTP.

Located-in and contains relationships share one child-to-container graph, rejecting self-references, cycles, unsupported containers and multiple spatial parents. Simulates links independent simulated and physical Entities from the same definition. The server records manual provenance and registration actor/time; retained relationship ids keep their meaning and original provenance. Client-supplied provenance is rejected. Conditional insertion and affected-row checks prevent cross-Lab id races from being acknowledged as successful registration.

Copying an Entity creates a new identity from its frozen definition, configuration and appearance. New device Bindings are independent; source Runs, observations and relationships are not copied. Adding a representation retains Entity identity. Removing every node preserves the Entity and its relationships, and the directory exposes unplaced objects for restoration. World snapshots retain the asset metadata needed to restore an unplaced imported representation.

The page stores a draft separately from the latest runtime snapshot. Conflict feedback and the reload action remain visible while the user continues editing. Reload merges local node/relationship changes onto the latest layout, preserving untouched nodes and another editor's additions; an explicit retry uses the local node when both editors changed it. Drafts survive Lab/mode changes within the page. Persisted results recover in another browser; unsaved drafts do not claim persistence after leaving or refreshing the page.

Real device commands and reports do not change layout versions. HTTP and browser checks apply observations while a coordinate draft is open, then save without conflict and compare unchanged Run/observation records. Layout requests cannot submit runtime data.

## Simplification

The repository-owned reduce-complexity pass covers the full task diff, including staged/unstaged and task-owned new files, from the base above. The final PR records its immutable input tree alongside the independent two-axis review.

Version comparison uses one shared lock operation. Node and relationship identity checks use lookup maps, the directory derives a shared placed-Entity set, and relationship display indexes Entities and provenance records. Placement validation is shared with the existing node creation endpoint. Copying captures a checked snapshot instead of asserting that query data exists. Node selection uses the existing icon tool component, while transform selection uses the shared single-selection ToggleGroup rather than view tabs. Temporary diagnostic logging was removed.

The pass preserves authentication/CSRF, transaction-local credential checks, rollback, frozen definitions, provenance and the separation between Placement, registered facts and runtime state. It includes the relationship-id race guard and the continued-editing conflict recovery check. No larger refactor was required.

## Validation

- `node scripts/test-backend.mjs --test lab_world --test lab_devices`: 8 World and 9 device cases passed after simplification. Tests use the real Router and isolated PostgreSQL; public device runtime processing supplies deterministic observation completion.
- `pnpm test:frontend apps/web/src/lab-world.test.tsx apps/web/src/lab-devices.test.tsx`: 9 cases passed. Pages replace only HTTP with MSW, covering explicit registration, unchanged provenance after coordinates change, removal/restoration, and conflict editing/reload/retry with another editor's additions retained.
- `just check`: passed with 63 tooling, 198 Rust and 265 frontend cases, plus 4 existing frontend skips. Format, Clippy, lint/types, generated contracts, boundaries, deterministic budgets, web/desktop builds and bilingual documentation builds passed. Initial payload is 226.9 KiB gzip; the largest asynchronous chunk is 308.5 KiB. Existing budgets are unchanged.
- `node scripts/e2e.mjs tests/e2e/lab-layout.spec.ts tests/e2e/lab.spec.ts`: the combined run passed all 5 journeys, including the complete layout journey and existing WebGL fallback, persistent multi-model identity/resources, asset failure recovery and Draco/Meshopt/Basis scale checks. After the transform-control semantics fix, `node scripts/e2e.mjs tests/e2e/lab-layout.spec.ts` passed again on the final UI. The layout journey reports no page errors.

The browser checks use real application services, isolated PostgreSQL/Redis/object storage, independent Member contexts and Chromium/WebGL. Pointer tests locate visible transform axes through canvas pixels and exercise translation, rotation and scale, then compare persisted Placement and identical registered relationships. They also exercise independent copying, two nodes for one Entity, removal/restoration, two-browser conflicts retaining both edits, commands while editing, and numeric-arrow/Enter keyboard operation. The executable Agent tutorial runs against the same real stack and verifies its conflict, rejection, identity and provenance assertions.

The last broad run exposed an existing compressed-import test waiting only the default 5 seconds for its new rendered title. Its actual successful upload/verification/download took longer under combined browser load. The title assertion now permits 45 seconds, matching the existing 40-second verification request plus rendering, while retaining the 120-second journey timeout and exact model/pixel/scale assertions. Final combined validation passed; no production import behavior or deterministic performance budget changed.

## Accepted Experience

The actual application was compared with the fixed preview's placement/location, save-conflict, desktop and narrow-screen states. It retains the shell, object directory, full scene and Inspector, with separate layout/runtime views and explicit relationship registration. Gizmos use the existing Drei TransformControls. Transform helpers are outside the scene fitting boundary; fitting responds to node structure, first resource readiness, viewport changes and explicit focus, rather than every Placement edit or runtime poll. A transform target also carries its node id so removal cannot attach a control to a different or detached node.

Captured workspace evidence is in `test-results/lab-foundation/`: `t04-layout-desktop.png`, `t04-layout-conflict.png`, `t04-layout-mobile-dark-en.png`, `t04-layout-mobile-relationships-en.png` and `t04-layout-mobile-placement-en.png`. At 320px, English relationship selection, all nine numeric inputs and saving are operable; the page has no horizontal overflow and the two canvas toolbars do not overlap. Actual screenshots were inspected separately from the functional assertions. SwiftShader rendering does not establish target-hardware performance thresholds.

The bilingual [tutorial](../tutorials/edit-layout.md), [English chapter](../tutorials/edit-layout.en.md), executable [Agent requests](../../examples/lab/edit-layout.mjs), generated OpenAPI/SDK and [ownership manifest](../../crates/app/src/modules/lab/module.json) ship with the behavior. The PR records final Standards/Spec results, reviewed tree, head and required CI checks.
