# Lab Viewer Implementation Validation

Scope: the user's accepted v1 experience and direct implementation instruction, including replacement of the sidebar Knowledge entry with a session-local Asset Library. The initial implementation revision was `44080e0ffc407ef5fdf070c993ab1945d8aa0130`; concurrent product-documentation work advanced HEAD to `9d9acbe4b11f4d5c33d71285e0089333ef237683`. That unrelated work is preserved.

## Simplification

The repository-owned reduce-complexity pass inspected the new `packages/views/src/lab/` modules, their assembly adapter, public page tests, typed model loader, owned runtime/source assets and paired guide. Shared GLB validation/file input serves both pages, the catalog follows the existing identity cache lifecycle, and Three.js is isolated behind the viewer's dynamic import. No additional abstraction was justified in this pass; parsing, rendered resources and client catalog metadata have distinct lifetimes. Input validation, abort handling, legacy document URLs and resource disposal remain required.

## Executed Checks

- TypeScript and focused ESLint passed for the implementation.
- The new public page tests verify preset/navigation, local import/search and route return, confirmed removal, and invalid-import recovery. Existing registration and shell-composition tests pass.
- Real API registration landed on `/lab`; Chromium/SwiftShader verified GLB/HDR canvas pixels, actual camera movement and raycast selection, local import/catalog round trip, failed-import retention, narrow layout, theme/language, and stability under repeated browser warnings. No browser page/console errors were recorded. Screenshots and the run report are local under `.scratch/lab-runtime/evidence/`.
- Web build and semantic-theme checks passed. The unchanged bundle checker passed at 221.7 KiB initial gzip and 310.5 KiB for the viewport async chunk.
- Documentation source/navigation/locale checks passed after adding the paired application guide.
- Final bounded-worker Web/shared-frontend run passed 236 tests (4 skipped). The isolated real-stack `tests/e2e/lab.spec.ts` journey passed after fixing its synchronization to wait for the public `aria-busy` loading state; the initial run raced an unfinished model load and was not counted as passing evidence.

## Whole-Repository Limits

`just check` stopped at `cargo fmt --all -- --check` on existing Rust files outside this frontend change. A full frontend run also found the existing Electron `labos_threejs` deep-link parser test failure. The generic boundary checker rejects an existing knowledge re-export from `packages/views/src/index.ts`, which this implementation does not modify. These are not represented as passing gates.

Knowledge-navigation test expectations changed to Lab/Asset Library while preserving legacy direct-route coverage. The renderer runs without the preview's drawing-buffer retention; screenshot pixels are inspected through standard image decoding. Software-rendering FPS does not establish target-GPU performance.

## Review

Standards review found incomplete disposal for line/point primitives; Spec review found box framing, failed-model catalog selection and pending-import restore races. All four were fixed and rechecked independently, with no remaining actionable findings.

The browser regression verifies a unit cube stays inside the canvas, a deep accessor parse failure preserves the previous model across navigation, delayed file reads cannot override restoring the preset, and mixed mesh/line/point replacement returns the geometry count to its baseline (14 before and after). Fixtures and a public browser journey are retained under `tests/fixtures/lab/` and `tests/e2e/lab.spec.ts`.

The first unconstrained frontend rerun overlapped the documentation build and hit existing short UI timeouts. The affected files passed separately with bounded workers; final frontend verification uses two workers. No timing threshold was weakened. The isolated browser regression and full application checks remain distinct from target-GPU performance.

No GitHub implementation issue or PR is claimed by this local validation record.
